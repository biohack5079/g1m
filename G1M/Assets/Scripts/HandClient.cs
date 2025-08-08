using UnityEngine;
using SocketIOClient;
using SocketIOClient.Transport;
using System.Threading.Tasks;
using System;
using SocketIO.Core;
using Unity.WebRTC;
using System.Collections;
using System.Text;
using System.Collections.Generic;

// JSONデータを格納するためのクラス
[System.Serializable]
public class Landmark
{
    public float x;
    public float y;
    public float z;
}

// JSONデータ全体をパースするためのヘルパークラス
[System.Serializable]
public class HandLandmarksListWrapper
{
    public List<List<Landmark>> multiHandLandmarks;
}

public class HandClient : MonoBehaviour
{
    private SocketIOClient.SocketIO socket;
    private const string ServerUrl = "wss://g1m-pwa.onrender.com";

    private RTCPeerConnection _peerConnection;
    private RTCDataChannel _dataChannel;

    public static event Action<List<List<Landmark>>> OnLandmarksReceived;

    void Start()
    {
        InitializeSocketIO();
    }

    void Update()
    {
        WebRTC.Update();
    }

    void InitializeSocketIO()
    {
        // 既存の接続があればクリーンアップ
        if (socket != null && socket.Connected)
        {
            socket.DisconnectAsync();
        }
        
        var uri = new Uri(ServerUrl);
        socket = new SocketIOClient.SocketIO(uri, new SocketIOOptions
        {
            EIO = EngineIO.V4,
            Transport = TransportProtocol.WebSocket,
            ConnectionTimeout = new TimeSpan(0, 0, 20)
        });

        socket.OnConnected += async (sender, e) =>
        {
            Debug.Log("Socket.IO Connected!");
            // サーバーに自身の役割を通知
            await socket.EmitAsync("register_role", "unity");
            Debug.Log("Registered as 'unity' client.");
            // 接続成功後にWebRTCの初期化を開始
            InitializeWebRTC();
        };

        // PWAからOfferが届いたときに処理を開始
        socket.On("offer", response => StartCoroutine(HandleOfferAsync(response)));
        
        // PWAからICE candidateが届いたときに処理
        socket.On("candidate", response => StartCoroutine(HandleCandidateAsync(response)));
        
        // サーバーから切断を促すイベントを受け取った場合の処理
        socket.On("webrtc_close", response =>
        {
            Debug.Log("Received webrtc_close event from server.");
            CloseWebRTCConnection();
        });

        socket.OnDisconnected += (sender, e) => 
        {
            Debug.Log($"Socket.IO Disconnected! Reason: {e}");
            // ソケット切断時にWebRTC接続もクリーンアップ
            CloseWebRTCConnection();
            Debug.Log("Attempting to reconnect in 3 seconds...");
            Task.Delay(3000).ContinueWith(_ => ConnectSocketAsync());
        };
        
        socket.OnError += (sender, e) => Debug.LogError($"Socket.IO Error: {e}");
        
        ConnectSocketAsync();
    }

    void InitializeWebRTC()
    {
        // 既存のPeerConnectionを閉じてから再作成
        CloseWebRTCConnection();

        var configuration = new RTCConfiguration
        {
            iceServers = new RTCIceServer[]
            {
                new RTCIceServer { urls = new string[] { "stun:stun.l.google.com:19302" } },
            }
        };
        _peerConnection = new RTCPeerConnection(ref configuration);
        
        _peerConnection.OnDataChannel += channel => 
        {
            _dataChannel = channel;
            _dataChannel.OnOpen += () => Debug.Log("WebRTC DataChannel is now open! (Received from PWA)");
            _dataChannel.OnClose += () => Debug.Log("WebRTC DataChannel is closed.");
            _dataChannel.OnMessage += bytes => 
            {
                string handData = Encoding.UTF8.GetString(bytes);
                Debug.Log($"Received raw hand data: {handData}"); // 受信した生のJSONデータをログに出力
                try
                {
                    var parsedData = JsonUtility.FromJson<HandLandmarksListWrapper>("{\"multiHandLandmarks\":" + handData + "}");
                    if (parsedData != null)
                    {
                        OnLandmarksReceived?.Invoke(parsedData.multiHandLandmarks);
                    }
                }
                catch (System.Exception ex)
                {
                    Debug.LogError($"JSON parse error: {ex.Message} -> Received data was: {handData}");
                }
            };
        };

        _peerConnection.OnIceCandidate = candidate =>
        {
            if (candidate != null && socket.Connected)
            {
                var candidateObj = new {
                    candidate = candidate.Candidate,
                    sdpMid = candidate.SdpMid,
                    sdpMLineIndex = candidate.SdpMLineIndex
                };
                var candidateJson = JsonUtility.ToJson(candidateObj);
                Debug.Log("Sending ICE candidate.");
                socket.EmitAsync("candidate", candidateJson);
            }
        };
        
        // WebRTCの状態変化を監視するイベントハンドラを追加
        _peerConnection.OnConnectionStateChange += state =>
        {
            Debug.Log($"WebRTC connection state: {state}");
            if (state == RTCPeerConnectionState.Disconnected || state == RTCPeerConnectionState.Failed)
            {
                Debug.LogWarning("WebRTC connection failed or disconnected. Attempting to restart.");
                CloseWebRTCConnection();
                // ソケット接続が維持されている場合、WebRTCのみ再試行
                if (socket != null && socket.Connected) {
                    // PWAが再度Offerを送ってくれることを期待
                }
            }
        };
    }

    private IEnumerator HandleOfferAsync(SocketIOResponse response)
    {
        // 修正箇所：追加されたデバッグログ
        Debug.Log("HandleOfferAsync started.");
        
        if (_peerConnection == null)
        {
            Debug.LogError("PeerConnection is not initialized. Cannot handle offer.");
            yield break;
        }

        var offerJson = response.GetValue<string>();
        // 修正箇所：追加されたデバッグログ
        Debug.Log($"Offer JSON received: {offerJson}");

        var sdp = JsonUtility.FromJson<RTCSessionDescription>(offerJson);
        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
            yield break;
        }
        // 修正箇所：追加されたデバッグログ
        Debug.Log("SetRemoteDescription succeeded.");

        var op2 = _peerConnection.CreateAnswer();
        yield return op2;
        if (op2.IsError)
        {
            Debug.LogError($"CreateAnswer failed: {op2.Error.message}");
            yield break;
        }
        // 修正箇所：追加されたデバッグログ
        Debug.Log("CreateAnswer succeeded.");

        var answer = op2.Desc;
        var op3 = _peerConnection.SetLocalDescription(ref answer);
        yield return op3;
        if (op3.IsError)
        {
            Debug.LogError($"SetLocalDescription failed: {op3.Error.message}");
            yield break;
        }
        // 修正箇所：追加されたデバッグログ
        Debug.Log("SetLocalDescription succeeded.");
        
        var answerJson = JsonUtility.ToJson(answer);
        // 修正箇所：追加されたデバッグログ
        Debug.Log($"Sending answer JSON: {answerJson}");
        socket.EmitAsync("answer", answerJson);
        // 修正箇所：追加されたデバッグログ
        Debug.Log("Answer sent to signaling server.");
    }
    
    private IEnumerator HandleCandidateAsync(SocketIOResponse response)
    {
        if (_peerConnection == null)
        {
            Debug.LogWarning("PeerConnection is not initialized yet. Discarding ICE candidate.");
            yield break;
        }

        var candidateJson = response.GetValue<string>();
        var iceCandidateInit = JsonUtility.FromJson<RTCIceCandidateInit>(candidateJson);

        if (iceCandidateInit != null && !string.IsNullOrEmpty(iceCandidateInit.candidate))
        {
            var rtcIceCandidate = new RTCIceCandidate(iceCandidateInit);
            bool success = _peerConnection.AddIceCandidate(rtcIceCandidate);
            
            if (success)
            {
                Debug.Log("Successfully added ICE candidate.");
            }
            else
            {
                Debug.LogError("Failed to add ICE candidate: candidate is invalid.");
            }
        }
        else
        {
            Debug.LogWarning("Received invalid ICE candidate JSON.");
        }
        yield break;
    }

    private async void ConnectSocketAsync()
    {
        // 既に接続試行中か接続済みであれば何もしない
        if (socket.Connected) return;

        Debug.Log($"Attempting to connect to {ServerUrl}...");
        try
        {
            await socket.ConnectAsync();
        }
        catch (Exception e)
        {
            Debug.LogError($"Connection failed: {e.GetType().Name} - {e.Message}");
            // 接続失敗時に再試行
            Task.Delay(5000).ContinueWith(_ => ConnectSocketAsync());
        }
    }

    private void CloseWebRTCConnection()
    {
        if (_peerConnection != null)
        {
            _peerConnection.Close();
            _peerConnection.Dispose();
            _peerConnection = null;
            Debug.Log("WebRTC PeerConnection has been closed and disposed.");
        }
        _dataChannel = null;
    }
    
    void OnDestroy()
    {
        CloseWebRTCConnection();
        if (socket != null && socket.Connected)
        {
            socket.DisconnectAsync();
        }
    }
}