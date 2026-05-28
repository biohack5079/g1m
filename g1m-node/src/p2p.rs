use futures_util::StreamExt;
use libp2p::{
    core::upgrade::Version,
    gossipsub, mdns, noise, tcp, yamux, Multiaddr, PeerId, Transport,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;
use tokio::sync::mpsc;

// P2P Command sent from the Web Server to the P2P swarm
#[derive(Debug, Clone)]
pub enum P2PCommand {
    PublishChat { id: String, text: String, sender_name: String },
    PublishSignal { target_id: String, payload: String },
    SyncDatabase { table: String, data: String },
}

// P2P Event sent from the P2P swarm to the Web Server
#[derive(Debug, Clone)]
pub enum P2PEvent {
    PeerDiscovered(PeerId),
    PeerExpired(PeerId),
    ChatMessageReceived { id: String, text: String, sender_name: String },
    SignalReceived { target_id: String, payload: String },
    DatabaseSyncReceived { table: String, data: String },
}

#[derive(libp2p::swarm::NetworkBehaviour)]
pub struct G1MBehaviour {
    pub gossipsub: gossipsub::Behaviour,
    pub mdns: mdns::tokio::Behaviour,
}

pub async fn run_p2p_node(
    mut cmd_rx: mpsc::Receiver<P2PCommand>,
    event_tx: mpsc::Sender<P2PEvent>,
    listen_port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    // 1. Create a PeerId
    let local_key = libp2p::identity::Keypair::generate_ed25519();
    let local_peer_id = PeerId::from(local_key.public());
    log::info!("Local peer id: {:?}", local_peer_id);

    // 3. Build Gossipsub Behaviour
    // To content-address message, we can hash the message content
    let message_id_fn = |message: &gossipsub::Message| {
        let mut s = DefaultHasher::new();
        message.data.hash(&mut s);
        gossipsub::MessageId::from(s.finish().to_string())
    };

    let gossipsub_config = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(Duration::from_secs(1))
        .validation_mode(gossipsub::ValidationMode::Strict)
        .message_id_fn(message_id_fn)
        .build()?;

    let mut gossipsub = gossipsub::Behaviour::new(
        gossipsub::MessageAuthenticity::Signed(local_key),
        gossipsub_config,
    )?;

    // Subscribe to G1M topics
    let chat_topic = gossipsub::IdentTopic::new("g1m-chat");
    let signal_topic = gossipsub::IdentTopic::new("g1m-signaling");
    let sync_topic = gossipsub::IdentTopic::new("g1m-dbsync");
    gossipsub.subscribe(&chat_topic)?;
    gossipsub.subscribe(&signal_topic)?;
    gossipsub.subscribe(&sync_topic)?;

    // 4. Build Mdns Behaviour
    let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)?;

    // 5. Create Behaviour Struct
    let behaviour = G1MBehaviour { gossipsub, mdns };

    // 6. Build Swarm with 0.52.x API
    let mut swarm = libp2p::SwarmBuilder::with_existing_identity(local_key)
        .with_tokio()
        .with_other_transport(|key| {
            tcp::tokio::Transport::default()
                .upgrade(Version::V1Lazy)
                .authenticate(noise::Config::new(key)?)
                .multiplex(yamux::Config::default())
        })?
        .with_behaviour(|_| behaviour)?
        .build();

    // Listen on IPv4 and TCP port
    let listen_addr = format!("/ip4/0.0.0.0/tcp/{}", listen_port).parse::<Multiaddr>()?;
    swarm.listen_on(listen_addr)?;
    log::info!("P2P Swarm listening on port {}", listen_port);

    // 7. Event loop
    loop {
        tokio::select! {
            // Receive command from Web API / user interface
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    P2PCommand::PublishChat { id, text, sender_name } => {
                        let payload = serde_json::json!({
                            "id": id,
                            "text": text,
                            "sender_name": sender_name
                        });
                        let data = serde_json::to_vec(&payload).unwrap_or_default();
                        if let Err(e) = swarm.behaviour_mut().gossipsub.publish(chat_topic.clone(), data) {
                            log::warn!("Gossipsub publish chat error: {:?}", e);
                        }
                    }
                    P2PCommand::PublishSignal { target_id, payload } => {
                        let json_payload = serde_json::json!({
                            "target_id": target_id,
                            "payload": payload
                        });
                        let data = serde_json::to_vec(&json_payload).unwrap_or_default();
                        if let Err(e) = swarm.behaviour_mut().gossipsub.publish(signal_topic.clone(), data) {
                            log::warn!("Gossipsub publish signal error: {:?}", e);
                        }
                    }
                    P2PCommand::SyncDatabase { table, data } => {
                        let json_payload = serde_json::json!({
                            "table": table,
                            "data": data
                        });
                        let payload_bytes = serde_json::to_vec(&json_payload).unwrap_or_default();
                        if let Err(e) = swarm.behaviour_mut().gossipsub.publish(sync_topic.clone(), payload_bytes) {
                            log::warn!("Gossipsub publish db sync error: {:?}", e);
                        }
                    }
                }
            }
            // Receive libp2p swarm event
            event = swarm.select_next_some() => {
                match event {
                    libp2p::swarm::SwarmEvent::NewListenAddr { address, .. } => {
                        log::info!("Swarm new listen address: {:?}", address);
                    }
                    libp2p::swarm::SwarmEvent::Behaviour(G1MBehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
                        for (peer_id, addr) in list {
                            log::info!("Discovered peer {} at address {:?}", peer_id, addr);
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                            let _ = event_tx.send(P2PEvent::PeerDiscovered(peer_id)).await;
                        }
                    }
                    libp2p::swarm::SwarmEvent::Behaviour(G1MBehaviourEvent::Mdns(mdns::Event::Expired(list))) => {
                        for (peer_id, addr) in list {
                            log::info!("Peer {} expired at address {:?}", peer_id, addr);
                            swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
                            let _ = event_tx.send(P2PEvent::PeerExpired(peer_id)).await;
                        }
                    }
                    libp2p::swarm::SwarmEvent::Behaviour(G1MBehaviourEvent::Gossipsub(gossipsub::Event::Message {
                        propagation_source: _peer_id,
                        message_id: _id,
                        message,
                    })) => {
                        if message.topic == chat_topic.hash() {
                            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&message.data) {
                                let id = val["id"].as_str().unwrap_or_default().to_string();
                                let text = val["text"].as_str().unwrap_or_default().to_string();
                                let sender_name = val["sender_name"].as_str().unwrap_or_default().to_string();
                                let _ = event_tx.send(P2PEvent::ChatMessageReceived { id, text, sender_name }).await;
                            }
                        } else if message.topic == signal_topic.hash() {
                            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&message.data) {
                                let target_id = val["target_id"].as_str().unwrap_or_default().to_string();
                                let payload = val["payload"].as_str().unwrap_or_default().to_string();
                                let _ = event_tx.send(P2PEvent::SignalReceived { target_id, payload }).await;
                            }
                        } else if message.topic == sync_topic.hash() {
                            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&message.data) {
                                let table = val["table"].as_str().unwrap_or_default().to_string();
                                let data = val["data"].as_str().unwrap_or_default().to_string();
                                let _ = event_tx.send(P2PEvent::DatabaseSyncReceived { table, data }).await;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}
