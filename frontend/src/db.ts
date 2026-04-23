/**
 * ブラウザのIndexedDBを使用して、デバイス固有の匿名IDを保存・取得するためのユーティリティ。
 */
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
                    // IDが存在しない場合は新規発行 (UUID風)
                    const newId = 'anon-' + Math.random().toString(36).substring(2, 15);
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
