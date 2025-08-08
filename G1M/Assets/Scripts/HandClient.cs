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
    private bool _isSocketConnecting = false;
    private bool _hasConnectedOnce = false;

    public static event Action<List<List<Landmark>>> OnLandmarksReceived;

    void Start()
    {
        InitializeSocketIO();
    }

    void Update()
    {
        // WebRTCのイベント処理を毎フレーム実行する
        WebRTC.Update();
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

        socket.OnConnected += (sender, e) =>
        {
            Debug.Log("Socket.IO Connected!");
            _isSocketConnecting = false;
            _hasConnectedOnce = true;
        };
        
        // PWA側がOfferを作成するため、Unity側は待機する。
        // ready_to_connectイベントは、PWAからOfferを受け取るための準備ができたことを知らせるだけ。
        socket.On("ready_to_connect", response => 
        {
            Debug.Log("PWA is ready. Waiting for WebRTC offer.");
            // このタイミングでは何もせず、PWAからのOfferを待つ
        });

        var configuration = new RTCConfiguration
        {
            iceServers = new RTCIceServer[]
            {
                new RTCIceServer { urls = new string[] { "stun:stun.l.google.com:19302" } },
                new RTCIceServer { urls = new string[] { "stun:stun1.l.google.com:19302" } },
                new RTCIceServer { urls = new string[] { "stun:stun2.l.google.com:19302" } },
                new RTCIceServer { urls = new string[] { "stun:stun.services.mozilla.com:3478" } },
                new RTCIceServer { urls = new string[] { "stun:stun.voip.blackberry.com:3478" } }
            }
        };
        _peerConnection = new RTCPeerConnection(ref configuration);
        
        // PWA側がDataChannelを作成するので、Unity側はそれを受け取るハンドラを設定
        _peerConnection.OnDataChannel += channel => 
        {
            _dataChannel = channel;
            _dataChannel.OnOpen += () => 
            {
                Debug.Log("WebRTC DataChannel is now open! (Received from PWA)");
            };
            _dataChannel.OnClose += () => 
            {
                Debug.Log("WebRTC DataChannel is closed.");
            };
            _dataChannel.OnMessage += bytes => 
            {
                string handData = Encoding.UTF8.GetString(bytes);
                Debug.Log($"Received hand data JSON: {handData}");
                try
                {
                    // JSONUtilityでのパース処理
                    var parsedData = JsonUtility.FromJson<HandLandmarksListWrapper>("{\"multiHandLandmarks\":" + handData + "}");
                    if (parsedData != null)
                    {
                        OnLandmarksReceived?.Invoke(parsedData.multiHandLandmarks);
                    }
                }
                catch (System.Exception ex)
                {
                    Debug.LogError($"JSON parse error: {ex.Message}");
                    Debug.Log("Received data was: " + handData);
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
                Debug.Log($"Sending ICE candidate: {candidateJson}");
                socket.EmitAsync("candidate", candidateJson);
            }
        };
        
        // UnityはAnswerを作成・送信する役割
        socket.On("offer", response => StartCoroutine(HandleOfferAsync(response)));
        
        // UnityはOfferを受け取る役割から外れる
        // socket.On("answer", ...);
        
        // candidateは双方向で処理するため変更なし
        socket.On("candidate", response => StartCoroutine(HandleCandidateAsync(response)));

        socket.OnDisconnected += (sender, e) => 
        {
            Debug.Log("Socket.IO Disconnected! Reason: " + e);
            if (!_isSocketConnecting)
            {
                Debug.Log("Attempting to reconnect...");
                ConnectSocketAsync();
            }
        };
        
        socket.OnError += (sender, e) => Debug.LogError($"Socket.IO Error: {e}");
        
        ConnectSocketAsync();
    }

    // PWA側がOfferを作成するため、このメソッドは不要になります
    // private IEnumerator CreateOfferAndSend() { ... }

    private IEnumerator HandleOfferAsync(SocketIOResponse response)
    {
        Debug.Log("Received an offer from Web client.");
        var offerJson = response.GetValue<string>();
        Debug.Log($"Offer received from PWA: {offerJson}"); // ログを追加
        var sdp = JsonUtility.FromJson<RTCSessionDescription>(offerJson);

        var op1 = _peerConnection.SetRemoteDescription(ref sdp);
        yield return op1;
        if (op1.IsError)
        {
            Debug.LogError($"SetRemoteDescription failed: {op1.Error.message}");
            yield break;
        }
        Debug.Log("Set remote description successfully."); // ログを追加

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
        Debug.Log("Set local description (answer) successfully."); // ログを追加
        
        var answerJson = JsonUtility.ToJson(answer);
        Debug.Log($"Sending answer JSON: {answerJson}"); // ログを追加
        socket.EmitAsync("answer", answerJson);
        Debug.Log("Answer sent to PWA."); // ログを追加
    }
    
    // このメソッドはPWAがAnswerを作成する際に使用する。今回はUnityが作成するので不要になる。
    // private IEnumerator HandleAnswerAsync(SocketIOResponse response) { ... }

    private IEnumerator HandleCandidateAsync(SocketIOResponse response)
    {
        Debug.Log("Received an ICE candidate.");
        var candidateJson = response.GetValue<string>();
        Debug.Log($"Received ICE candidate JSON: {candidateJson}"); // ログを追加
        
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
        // (中略) 変更なし
        if (_isSocketConnecting) return;
        _isSocketConnecting = true;

        if (_hasConnectedOnce)
        {
            Debug.Log($"Attempting to reconnect to {ServerUrl}...");
            await Task.Delay(2000);
        }
        else
        {
            Debug.Log($"Attempting to connect to {ServerUrl}...");
        }

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
            _isSocketConnecting = false;
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