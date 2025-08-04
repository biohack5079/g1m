using UnityEngine;
using SocketIOClient;
using SocketIOClient.Transport;
using System.Threading.Tasks;
using System;
using SocketIO.Core;
using Unity.WebRTC; // この行を追加

public class HandClient : MonoBehaviour
{
    private SocketIOClient.SocketIO socket;
    private const string ServerUrl = "https://g1m-pwa.onrender.com";

    private RTCPeerConnection _peerConnection;
    private MediaStream _remoteStream;
    private VideoStreamTrack _remoteVideoTrack;
    private Renderer _renderer;
    private bool _isInitialized = false;

    
    void Start()
    {
        InitializeSocketIO();
    }

    void InitializeSocketIO()
    {
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
            await socket.EmitAsync("handshake", "UnityClient");
        };

        // ここにWebRTCの初期化ロジックを追加
        var configuration = new RTCConfiguration
        {
            iceServers = new RTCIceServer[]
            {
                new RTCIceServer { urls = new string[] { "stun:stun.l.google.com:19302" } }
            }
        };
        _peerConnection = new RTCPeerConnection(ref configuration);
        
        _peerConnection.OnIceCandidate = candidate =>
        {
            // 取得したcandidateをSocket.IOで送信するロジックをここに書く
            // socket.EmitAsync("candidate", candidate.candidate.sdp);
        };

        socket.On("offer", async response =>
        {
            var offerJson = response.GetValue<string>(); // offerのデータを取得
            var sdp = JsonUtility.FromJson<RTCSessionDescription>(offerJson);
            await _peerConnection.SetRemoteDescription(ref sdp);
            
            // answerを生成して送信
            var answer = _peerConnection.CreateAnswer();
            await _peerConnection.SetLocalDescription(ref answer);
            var answerJson = JsonUtility.ToJson(answer);
            await socket.EmitAsync("answer", answerJson);
        });

        socket.On("answer", async response =>
        {
            var answerJson = response.GetValue<string>(); // answerのデータを取得
            var sdp = JsonUtility.FromJson<RTCSessionDescription>(answerJson);
            await _peerConnection.SetRemoteDescription(ref sdp);
        });

        socket.On("candidate", response =>
        {
            // var candidateData = response.GetValue<string>();
            // Debug.Log($"Received candidate: {candidateData}");
        });

        socket.OnDisconnected += (sender, e) =>
        {
            Debug.Log("Socket.IO Disconnected!");
        };

        socket.OnError += (sender, e) =>
        {
            Debug.LogError($"Socket.IO Error: {e}");
        };
        
        ConnectSocketAsync();
    }

    private async void ConnectSocketAsync()
    {
        Debug.Log($"Attempting to connect to {ServerUrl}...");
        try
        {
            await socket.ConnectAsync();
        }
        catch (Exception e)
        {
            Debug.LogError($"Connection failed: {e.GetType().Name} - {e.Message}");
            if (e.InnerException != null)
            {
                Debug.LogError($"Inner Exception: {e.InnerException.Message}");
            }
        }
    }
    
    public async Task EmitHandDataAsync(string data)
    {
        if (socket != null && socket.Connected)
        {
            await socket.EmitAsync("hand_data", data);
        }
    }

    void OnDestroy()
    {
        if (socket != null && socket.Connected)
        {
            socket.DisconnectAsync();
        }
    }
}