/**
 * ブラウザのIndexedDBを使用して、デバイス固有の匿名ID (UUID) を保存・取得するためのユーティリティ。
 */

/** UUID v4 を生成する */
const generateUUID = (): string => {
    // crypto.randomUUID が使える場合はそれを使う
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // フォールバック
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
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
