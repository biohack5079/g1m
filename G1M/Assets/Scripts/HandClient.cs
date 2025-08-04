using UnityEngine;
using SocketIOClient;
using SocketIOClient.Transport;
using System.Threading.Tasks;
using System;
using SocketIO.Core;

public class HandClient : MonoBehaviour
{
    private SocketIOClient.SocketIO socket;
    private const string ServerUrl = "https://g1m-pwa.onrender.com";

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

        // イベントハンドラは、受信したデータの型に応じて実装する必要があります
        socket.On("offer", response =>
        {
            // responseからデータを取得する例
            // var offerData = response.GetValue<string>();
            // Debug.Log($"Received offer: {offerData}");
        });

        socket.On("answer", response =>
        {
            // var answerData = response.GetValue<string>();
            // Debug.Log($"Received answer: {answerData}");
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