/**
 * ブラウザのIndexedDBを使用して、デバイス固有の匿名ID (UUID) を保存・取得するためのユーティリティ。
 */

/** UUID v4 を生成する */
const generateUUID = (): string => {
    // CyberNetCall (CNC) の ID 生成仕様に合わせ、英数字のランダム文字列を生成
    // 通常 CNC では Math.random().toString(36).slice(2) 形式が使われる
    return Math.random().toString(36).substring(2, 12) + 
           Math.random().toString(36).substring(2, 12);
};

export const getAnonymousId = async (): Promise<string> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("G1M_DB", 1);

        request.onupgradeneeded = (event: any) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains("user_info")) {
                db.createObjectStore("user_info");
            }
        };

        request.onsuccess = (event: any) => {
            const db = event.target.result;
            const transaction = db.transaction(["user_info"], "readwrite");
            const store = transaction.objectStore("user_info");
            const getRequest = store.get("anonymous_id");

            getRequest.onsuccess = () => {
                if (getRequest.result) {
                    resolve(getRequest.result);
                } else {
                    // IDが存在しない場合は新規UUID発行
                    const newId = generateUUID();
                    store.put(newId, "anonymous_id");
                    resolve(newId);
                }
            };
        };

        request.onerror = () => {
            reject("IndexedDBの初期化に失敗しました。");
        };
    });
};
