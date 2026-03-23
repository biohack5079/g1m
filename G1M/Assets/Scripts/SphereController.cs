using UnityEngine;
using System.Collections.Generic;

// LandmarkクラスはHandClient.csで定義されています。

public class SphereController : MonoBehaviour
{
    // =========================================================
    // マッピング設定（Unityインスペクタから調整可能）
    // =========================================================
    [Header("Hand Tracking Mapping Settings")]
    [Tooltip("PWAのX/Y座標 (0.0 - 1.0) をマッピングするワールド座標の最大幅/高さ。")]
    [SerializeField] private float mapRange = 10f; // 例: 10f -> -5f から +5f の範囲にマッピング

    // 追跡する手のランドマークID
    // MediaPipe HandsのランドマークID: 8 = 人差し指の先端 (Index Finger Tip)
    private const int IndexFingerTipId = 8; 

    // =========================================================
    // 内部状態
    // =========================================================
    private List<List<Landmark>> _multiHandLandmarks;
    private bool _isDataReceived = false; // データ受信フラグを追加

    void OnEnable()
    {
        // Singletonインスタンス経由でイベントを購読
        if (HandClient.Instance != null)
        {
            HandClient.Instance.OnLandmarksReceived += OnLandmarksReceived;
            Debug.Log("[SphereController] HandClient.OnLandmarksReceivedイベントを購読しました。✅");
        }
        else
        {
            // エラーログを強調
            Debug.LogError("[SphereController] 🔴 HandClient.Instanceが見つかりません。HandClientスクリプトがシーン内のWebRTC Clientにアタッチされているか、Awake/Startの実行順序を確認してください。");
        }
    }

    void OnDisable()
    {
        // イベント購読を解除
        if (HandClient.Instance != null)
        {
            HandClient.Instance.OnLandmarksReceived -= OnLandmarksReceived;
            Debug.Log("[SphereController] HandClient.OnLandmarksReceivedイベントの購読を解除しました。");
        }
    }

    private void OnLandmarksReceived(List<List<Landmark>> landmarks)
    {
        // 受信した最新のランドマークデータを保存
        _multiHandLandmarks = landmarks;
        // ★ イベントが発火したことを示すログを追加
        if (!_isDataReceived)
        {
            Debug.Log("[SphereController] ⭐ 初回データ受信成功！Updateループでの座標更新を確認します。");
            _isDataReceived = true;
        }
    }

    void Update()
    {
        // 処理に必要なデータが揃っているかを確認
        if (_multiHandLandmarks == null || _multiHandLandmarks.Count == 0)
        {
            // ランドマークデータがない場合は処理をスキップ
            return;
        }

        // 最初の手のランドマークを取得
        var firstHandLandmarks = _multiHandLandmarks[0];

        // 追跡したいランドマーク（人差し指の先端）が存在するか確認
        if (firstHandLandmarks.Count > IndexFingerTipId)
        {
            var indexFingerTip = firstHandLandmarks[IndexFingerTipId];
            
            // マッピング範囲の中心値
            float centerOffset = mapRange / 2f;

            // PWAの画面座標（0.0-1.0）をUnityのワールド座標に変換
            
            // X軸マッピング: [0, 1] -> [-centerOffset, +centerOffset]
            float xPos = indexFingerTip.x * mapRange - centerOffset; 

            // Y軸マッピング: Y軸はPWAでは上が0、下が1。Unityでは上が正、下が負なので反転が必要。
            float yPos = (1f - indexFingerTip.y) * mapRange - centerOffset; 

            // Z軸: 固定値
            float zPos = 0f; 

            Vector3 newPosition = new Vector3(xPos, yPos, zPos);
            
            // ★ 座標更新が実行されていることを確認するためのログ
            if (_isDataReceived)
            {
                 // ログの出しすぎを防ぐため、100フレームに1回程度に間引く
                 if (Time.frameCount % 100 == 0)
                 {
                     Debug.Log($"[SphereController] 座標更新中！ Raw X:{indexFingerTip.x:F3}, Raw Y:{indexFingerTip.y:F3} -> World: {newPosition}");
                 }
            }

            // オブジェクトの位置を更新
            this.transform.position = newPosition;
        }
        else
        {
            // データが受信されているのに、ランドマークが21個未満の場合のデバッグログ
            if (_isDataReceived && Time.frameCount % 500 == 0)
            {
                 Debug.LogWarning("[SphereController] 警告: ランドマークデータを受信したが、ランドマーク数が IndexFingerTipId (8) より少ない。");
            }
        }
    }
}