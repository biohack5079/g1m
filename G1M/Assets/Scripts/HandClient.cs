using UnityEngine;
using SocketIO.Core;
using SocketIOClient;
using SocketIOClient.Transport;
using System.Threading.Tasks;
using System;
using Unity.WebRTC; // この行を追加

// WebRTC関連のクラスを使用する場合、using Unity.WebRTC; が必要
// 今回はSocket.IOのDataChannelを使用するため、WebRTCの直接的な使用は省略
// もしWebRTCのAPIを使用するなら、別途Unity.WebRTCパッケージの導入とコード修正が必要です

public class HandClient : MonoBehaviour
{
    private SocketIOClient.SocketIO socket; // SocketIOUnityクラスは存在しないので、SocketIOに修正
    private const string ServerUrl = "https://your-render-app-name.onrender.com";

    // WebRTC関連のメンバー変数を追加
    private RTCPeerConnection _peerConnection;
    private MediaStream _remoteStream;
    private VideoStreamTrack _remoteVideoTrack;
    private Renderer _renderer; // 映像を表示するRenderer
    private bool _isInitialized = false;

    // Start関数で非同期処理を呼び出す
    void Start()
    {
        InitializeSocketIO();
    }

    void InitializeSocketIO()
    {
        // オプション設定
        var uri = new Uri(ServerUrl);
        socket = new SocketIOClient.SocketIO(uri, new SocketIOOptions
        {
            EIO = SocketIOClient.Core.EngineIO.V4,
            Transport = TransportProtocol.WebSocket, // WebSocketを使用
            ConnectionTimeout = new TimeSpan(0, 0, 20)
        });

        // イベントハンドラの設定
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
        
        _peerConnection.OnTrack = e =>
        {
            if (e.Track is VideoStreamTrack videoTrack)
            {
                _remoteVideoTrack = videoTrack;
                // ビデオトラックが追加されたら、映像を表示するロジックをここに書く
            }
        };
        
        // ...
    }



    // ...
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
    // ...

        socket.On("candidate", async response =>
        {
            // candidateを処理するロジック
        });

        socket.OnDisconnected += (sender, e) =>
        {
            Debug.Log("Socket.IO Disconnected!");
        };

        socket.OnError += (sender, e) =>
        {
            Debug.LogError($"Socket.IO Error: {e}");
        };
        
        // 接続を開始
        ConnectSocketAsync();
    }

    private async void ConnectSocketAsync()
    {
        Debug.Log($"Attempting to connect to {ServerUrl}..."); // ログを追加
        try
        {
            await socket.ConnectAsync();
            // 接続が成功すると、OnConnectedイベントが呼ばれる
        }
        catch (Exception e)
        {
            // 接続に失敗した場合、ここにログが出るはず
            Debug.LogError($"Connection failed: {e.Message}");
        }
    }
    
    // 他のイベントでデータを送信する場合
    public async Task EmitHandDataAsync(string data)
    {
        if (socket.Connected)
        {
            await socket.EmitAsync("hand_data", data);
        }
    }

    void OnDestroy()
    {
        // シーンが終了するときにソケットを閉じる
        if (socket != null && socket.Connected)
        {
            socket.DisconnectAsync();
        }
    }
}