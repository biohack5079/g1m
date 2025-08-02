const socket = io();

const video = document.getElementById('localVideo');

navigator.mediaDevices.getUserMedia({ video: true, audio: false })
  .then(stream => {
    video.srcObject = stream;
    startWebRTC(stream);
  });

let peer = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

function startWebRTC(stream) {
  stream.getTracks().forEach(track => peer.addTrack(track, stream));

  peer.onicecandidate = (e) => {
    if (e.candidate) socket.emit('candidate', e.candidate);
  };

  socket.on('offer', async (offer) => {
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    socket.emit('answer', answer);
  });

  socket.on('answer', async (answer) => {
    await peer.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('candidate', async (candidate) => {
    try {
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Failed to add ICE candidate:', err);
    }
  });

  peer.createOffer().then(offer => {
    peer.setLocalDescription(offer);
    socket.emit('offer', offer);
  });
}
