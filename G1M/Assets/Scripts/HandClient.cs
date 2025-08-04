using UnityEngine;
using SocketIOClient;
using SocketIOClient.Transport;
using System.Threading.Tasks;
using System;
using SocketIO.Core;
using Unity.WebRTC;
using System.Collections;

public class HandClient : MonoBehaviour
{
    private SocketIOClient.SocketIO socket;
    private const string ServerUrl = "https://g1m-pwa.onrender.com";

    private RTCPeerConnection _peerConnection;
    private MediaStream _remoteStream;
    private VideoStreamTrack _remoteVideoTrack;
    private Renderer _renderer;
    private bool _isInitialized = false;

    // // Start is called before the first frame update
    // void Start()
    // {
    //     WebRTC.Initialize(WebRTCSettings.WebRTCInitializeFlags, () =>
    //     {
    //         InitializeSocketIO();
    //     });
    // }

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

        // WebRTCの初期化ロジック
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
            if (candidate != null && socket.Connected)
            {
                var candidateJson = JsonUtility.ToJson(candidate);
                socket.EmitAsync("candidate", candidateJson);
            }
        };
        
        // **イベントハンドラの登録**
        socket.On("offer", response => StartCoroutine(HandleOfferAsync(response)));
        socket.On("answer", response => StartCoroutine(HandleAnswerAsync(response)));
        socket.On("candidate", response => StartCoroutine(HandleCandidateAsync(response)));

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

    // `offer`イベントのハンドラ
    private IEnumerator HandleOfferAsync(SocketIOResponse response)
    {
        Debug.Log("Received an offer from Web client.");
        var offerJson = response.GetValue<string>();
        var sdp = JsonUtility.FromJson<RTCSessionDescription>(offerJson);

        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
            yield break;
        }

        var op2 = _peerConnection.CreateAnswer();
        yield return op2;
        if (op2.IsError)
        {
            Debug.LogError($"CreateAnswer failed: {op2.Error.message}");
            yield break;
        }

        var answer = op2.Desc;
        var op3 = _peerConnection.SetLocalDescription(ref answer);
        yield return op3;
        if (op3.IsError)
        {
            Debug.LogError($"SetLocalDescription failed: {op3.Error.message}");
            yield break;
        }
        
        var answerJson = JsonUtility.ToJson(answer);
        socket.EmitAsync("answer", answerJson);
    }
    
    // `answer`イベントのハンドラ
    private IEnumerator HandleAnswerAsync(SocketIOResponse response)
    {
        Debug.Log("Received an answer from Web client.");
        var answerJson = response.GetValue<string>();
        var sdp = JsonUtility.FromJson<RTCSessionDescription>(answerJson);

        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
        }
    }

    // `candidate`イベントのハンドラ
    private IEnumerator HandleCandidateAsync(SocketIOResponse response)
    {
        var candidateJson = response.GetValue<string>();
        var candidate = JsonUtility.FromJson<RTCIceCandidate>(candidateJson);

        if (candidate != null)
        {
            _peerConnection.AddIceCandidate(candidate);
        }
        yield break;
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
        if (_peerConnection != null)
        {
            _peerConnection.Close();
            _peerConnection.Dispose();
        }
        if (socket != null && socket.Connected)
        {
            socket.DisconnectAsync();
        }
    }
}