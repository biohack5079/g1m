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

// JSONデータを格納するためのクラスを再定義
[System.Serializable]
public class Landmark
{
    public float x;
    public float y;
    public float z;
}

// ランドマークのリストを格納するためのクラス
[System.Serializable]
public class HandLandmarks
{
    public List<Landmark> landmarks;
}

public class HandClient : MonoBehaviour
{
    private SocketIOClient.SocketIO socket;
    private const string ServerUrl = "https://g1m-pwa.onrender.com";

    private RTCPeerConnection _peerConnection;
    private bool _isInitialized = false;

    // ランドマークデータを受け渡すためのイベント
    public static event Action<List<List<Landmark>>> OnLandmarksReceived;

    void Start()
    {
        WebRTC.Initialize(WebRTCSettings.WebRTCInitializeFlags, () =>
        {
            InitializeSocketIO();
        });
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
                // JsonUtilityはRTCIceCandidateをそのままシリアライズできない場合があるため、手動で処理
                var candidateDict = new Dictionary<string, string>
                {
                    {"candidate", candidate.candidate},
                    {"sdpMid", candidate.sdpMid},
                    {"sdpMLineIndex", candidate.sdpMLineIndex.ToString()}
                };
                var candidateJson = JsonUtility.ToJson(candidateDict);
                socket.EmitAsync("candidate", candidateJson);
            }
        };
        
        socket.On("offer", response => StartCoroutine(HandleOfferAsync(response)));
        socket.On("answer", response => StartCoroutine(HandleAnswerAsync(response)));
        socket.On("candidate", response => StartCoroutine(HandleCandidateAsync(response)));

        socket.OnDisconnected += (sender, e) => Debug.Log("Socket.IO Disconnected!");
        socket.OnError += (sender, e) => Debug.LogError($"Socket.IO Error: {e}");

        _peerConnection.OnDataChannel += channel =>
        {
            Debug.Log("DataChannel received!");
            channel.OnMessage += bytes =>
            {
                string handData = System.Text.Encoding.UTF8.GetString(bytes);
                
                try
                {
                    // JSONUtilityでのパースには、トップレベルのオブジェクトが必要
                    // ブラウザ側でJSON.stringify(results.multiHandLandmarks)しているので、
                    // この形式に合わせるためのラッパークラスが必要
                    var allHandsData = JsonUtility.FromJson<Wrapper<Wrapper<List<Landmark>>>>(handData);
                    
                    // TODO: 正しいJSON構造に合わせてパースロジックを調整する
                    // ブラウザからのJSON文字列の正確な形式が不明なため、JsonUtility.FromJson<>()が失敗する可能性があります。
                    // 以前提案したNewtonsoft.Jsonのほうが柔軟に対応できます。
                    
                    // 仮にパースが成功したとしてイベントを呼び出す
                    // OnLandmarksReceived?.Invoke(allHandsData.data);
                    
                    Debug.Log("Received hand data: " + handData);
                }
                catch (System.Exception ex)
                {
                    Debug.LogError($"JSON parse error: {ex.Message}");
                }
            };
        };
        ConnectSocketAsync();
    }
    
    // ...以降のHandleOfferAsync, HandleAnswerAsync, HandleCandidateAsyncは変更なし...
    // ...
}

// JsonUtilityで複数のリストをパースするためのヘルパークラス
[System.Serializable]
public class Wrapper<T>
{
    public T[] data;
}