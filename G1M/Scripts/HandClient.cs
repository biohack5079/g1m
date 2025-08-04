using UnityEngine;
using SocketIO.Core;
using SocketIOClient;
using SocketIOClient.Transport;
using System.Threading.Tasks;
using System;

// WebRTC関連のクラスを使用する場合、using Unity.WebRTC; が必要
// 今回はSocket.IOのDataChannelを使用するため、WebRTCの直接的な使用は省略
// もしWebRTCのAPIを使用するなら、別途Unity.WebRTCパッケージの導入とコード修正が必要です

public class HandClient : MonoBehaviour
{
    private SocketIOClient.SocketIO socket; // SocketIOUnityクラスは存在しないので、SocketIOに修正
    private const string ServerUrl = "https://your-render-app-name.onrender.com";

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

        socket.On("offer", async response =>
        {
            // ここにofferを受け取ったときのWebRTCロジックを記述
            // 現在のブラウザ側のコードでは、Unityクライアントがofferを送信し、
            // ブラウザ側がanswerを返す役割になっています。
            // よって、Unity側はofferを送信するロジックのみで良いはずです。
        });
        
        socket.On("answer", async response =>
        {
            // answerを処理するロジック
        });

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