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


        socket.On("offer", response => StartCoroutine(HandleOfferAsync(response)));

        private IEnumerator HandleOfferAsync(SocketIOResponse response)
        {
            var offerJson = response.GetValue<string>();
            var sdp = JsonUtility.FromJson<RTCSessionDescription>(offerJson);

            Debug.Log("SetRemoteDescription start");
            var op1 = _peerConnection.SetRemoteDescription(ref sdp);
            yield return op1;
            if (op1.IsError)
            {
                Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
                yield break;
            }
            
            Debug.Log("SetRemoteDescription complete");
            Debug.Log("CreateAnswer start");

            var op2 = _peerConnection.CreateAnswer();
            yield return op2;
            if (op2.IsError)
            {
                Debug.LogError($"CreateAnswer failed: {op2.Error.message}");
                yield break;
            }

            var answer = op2.Desc;
            Debug.Log("SetLocalDescription start");

            var op3 = _peerConnection.SetLocalDescription(ref answer);
            yield return op3;
            if (op3.IsError)
            {
                Debug.LogError($"SetLocalDescription failed: {op3.Error.message}");
                yield break;
            }

            Debug.Log("SetLocalDescription complete");
            var answerJson = JsonUtility.ToJson(answer);
            
            // awaitを使わずTask.Runで待機するか、Socket.IOの非同期処理に合わせて修正
            // UnityのMonoBehaviourはasync voidでasync Taskを待てないため、注意が必要
            socket.EmitAsync("answer", answerJson);
        }


        // public IEnumerator CreateOfferAsync()
        // {
        //     var op = _peerConnection.CreateOffer();
        //     yield return op;

        //     if (!op.IsError)
        //     {
        //         var offer = op.Desc;
        //         var op2 = _peerConnection.SetLocalDescription(ref offer);
        //         yield return op2;

        //         if (!op2.IsError)
        //         {
        //             var offerJson = JsonUtility.ToJson(offer);
        //             socket.EmitAsync("offer", offerJson); // または awaitableな方法で
        //         }
        //     }
        // }

        // 受信したanswerを処理する

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