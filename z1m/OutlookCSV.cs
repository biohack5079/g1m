using System; // Consoleクラスなど、基本的な機能を使うために必要
using System.Collections.Generic; // List<string> のようなコレクションクラスを使うために必要
using System.IO;                  // PathクラスやFileクラスなど、ファイル操作のために必要
using Microsoft.Office.Interop.Outlook; // Outlookの機能（予定表など）をプログラムから操作するために必要
using System.Text;                // UTF8Encodingクラスなど、文字エンコーディングを扱うために必要
using System.Runtime.InteropServices; // Marshal.ReleaseComObjectメソッドを使い、COMオブジェクトを解放するために必要

class Program // プログラムの本体となるクラスを定義
{
    static void Main() // プログラムが実行されたときに最初に呼び出されるメソッド (エントリーポイント)
    {
        // Outlook関連のオブジェクトを格納する変数を宣言。初期値はnullにしておく。
        Application outlookApp = null; // Outlookアプリケーション本体を表すオブジェクト
        NameSpace outlookNs = null;    // Outlookの名前空間（MAPI）を表すオブジェクト
        MAPIFolder calendarFolder = null; // Outlookの予定表フォルダを表すオブジェクト
        Items calendarItems = null;    // 予定表フォルダ内のアイテム（予定）のコレクションを表すオブジェクト
        try // エラーが発生する可能性のある処理をこのブロック内に記述
        {
            // CSVファイルの出力先パス (実行ファイルと同じディレクトリ)
            string csvOutputDirectory = AppDomain.CurrentDomain.BaseDirectory; // 現在実行中のプログラムがあるディレクトリのパスを取得
            string csvFileName = "OutlookCalendarExport.csv"; // 出力するCSVファイルの名前を定義
            string csvFilePath = Path.Combine(csvOutputDirectory, csvFileName); // ディレクトリパスとファイル名を結合して、完全なファイルパスを作成

            Console.WriteLine(string.Format("Outlookカレンダーの情報を取得し、{0} に出力します...", csvFilePath)); // 処理開始のメッセージをコンソールに表示

            outlookApp = new Application(); // Outlookアプリケーションの新しいインスタンスを作成（または既存のインスタンスに接続）
            outlookNs = outlookApp.GetNamespace("MAPI"); // OutlookのMAPI名前空間を取得
            // outlookNs.Logon(null, null, false, false); // 必要に応じてログオン処理 (通常は不要)
            calendarFolder = outlookNs.GetDefaultFolder(OlDefaultFolders.olFolderCalendar); // デフォルトの予定表フォルダを取得
            calendarItems = calendarFolder.Items; // 予定表フォルダ内のすべてのアイテム（予定）を取得

            // 定期的な予定を展開し、開始日で並べ替え (昇順)
            calendarItems.IncludeRecurrences = true; // 定期的な予定を個々の発生として展開するように設定
            calendarItems.Sort("[Start]", false); // 予定を開始日時 ([Start]) の昇順 (false) で並べ替え

            List<string> csvLines = new List<string>(); // CSVファイルの各行を格納するためのリストを作成
            // CSVファイルのヘッダー行
            csvLines.Add("件名,開始日時,終了日時,場所,終日イベント,本文プレビュー"); // リストの最初の要素としてヘッダー行を追加

            Console.WriteLine(string.Format("処理対象の予定アイテム数: {0}", calendarItems.Count)); // 取得した予定の総数をコンソールに表示
            int processedCount = 0; // 処理した予定の数をカウントする変数を初期化

            foreach (object itemObj in calendarItems) // 取得した予定アイテムのコレクションを一つずつ処理
            {
                AppointmentItem apptItem = itemObj as AppointmentItem; // 現在のアイテムを予定アイテム (AppointmentItem) 型に変換しようと試みる
                if (apptItem != null) // 変換が成功した場合 (つまり、アイテムが予定である場合)
                {
                    try // 個々の予定アイテム処理中にエラーが発生する可能性があるのでtryブロックで囲む
                    {
                        // 予定アイテムから各情報を取得し、CSV用にエスケープ処理
                        string subject = EscapeCsvField(apptItem.Subject); // 件名を取得し、CSVエスケープ
                        string start = apptItem.Start.ToString("yyyy-MM-dd HH:mm"); // 開始日時を指定した書式 ("年-月-日 時:分") の文字列に変換
                        string end = apptItem.End.ToString("yyyy-MM-dd HH:mm");     // 終了日時を指定した書式の文字列に変換
                        string location = EscapeCsvField(apptItem.Location); // 場所を取得し、CSVエスケープ
                        string allDayEvent = apptItem.AllDayEvent.ToString(); // 終日イベントかどうか (True/False) を文字列に変換
                        // 本文の先頭100文字を取得（改行はスペースに置換）
                        string bodyContent = apptItem.Body; // 予定の本文を取得
                        string rawBodyPreview = null; // 本文プレビュー用の一時変数をnullで初期化
                        if (bodyContent != null) // 本文がnullでない場合のみ処理
                        {
                            int actualLength = bodyContent.Length; // 本文の実際の長さを取得
                            int lengthToTake = Math.Min(actualLength, 100); // 取得する文字数を本文の長さと100の小さい方に設定 (最大100文字)
                            // bodyContentが空文字列の場合、lengthToTakeは0になり、Substring(0,0)は空文字列を返す
                            rawBodyPreview = bodyContent.Substring(0, lengthToTake); // 本文の先頭から指定文字数分を取得
                            rawBodyPreview = rawBodyPreview.Replace("\r\n", " "); // Windows形式の改行 (CRLF) をスペースに置換
                            rawBodyPreview = rawBodyPreview.Replace("\n", " ");   // Unix形式の改行 (LF) をスペースに置換
                            rawBodyPreview = rawBodyPreview.Replace("\r", " ");   // Mac形式の改行 (CR) をスペースに置換
                        }
                        // EscapeCsvFieldはnullや空文字列を適切に処理します
                        string bodyPreview = EscapeCsvField(rawBodyPreview); // 取得した本文プレビューをCSVエスケープ
                        // 取得した各情報をカンマ区切りの文字列として結合し、csvLinesリストに追加
                        csvLines.Add(string.Format("{0},{1},{2},{3},{4},{5}", subject, start, end, location, allDayEvent, bodyPreview));
                        processedCount++; // 処理済み予定数を1増やす
                    }
                    finally // 個々の予定アイテム処理のtryブロックに対応するfinallyブロック
                    {
                        // 各アイテムのCOMオブジェクトを解放
                        if (apptItem != null) Marshal.ReleaseComObject(apptItem); // 使用した予定アイテムのCOMオブジェクトを解放
                    }
                }
            }

            // csvLinesリストの内容を、指定したファイルパスにUTF-8 (BOM付き) エンコーディングで書き出す
            File.WriteAllLines(csvFilePath, csvLines, new UTF8Encoding(true)); // trueを指定することでBOMが付与される
            Console.WriteLine(string.Format("{0} 件の予定を {1} に保存しました。", processedCount, csvFilePath)); // 処理完了のメッセージをコンソールに表示
        }
        catch (System.Exception ex) // tryブロック内で何らかの例外 (エラー) が発生した場合に実行される
        {
            Console.WriteLine("エラーが発生しました: " + ex.Message); // エラーメッセージをコンソールに表示
            Console.WriteLine("スタックトレース: " + ex.StackTrace); // エラーが発生した場所などの詳細情報 (スタックトレース) を表示
        }
        finally // tryブロックの処理が正常に終了したか、例外が発生したかに関わらず、最後に必ず実行される
        {
            // 使用したCOMオブジェクトを解放
            // nullチェックを行いながら、Outlook関連の主要なCOMオブジェクトを解放する
            if (calendarItems != null) Marshal.ReleaseComObject(calendarItems); // Itemsオブジェクトを解放
            if (calendarFolder != null) Marshal.ReleaseComObject(calendarFolder); // MAPIFolderオブジェクトを解放
            if (outlookNs != null) Marshal.ReleaseComObject(outlookNs);       // NameSpaceオブジェクトを解放
            if (outlookApp != null) Marshal.ReleaseComObject(outlookApp);     // Applicationオブジェクトを解放
            Console.WriteLine("処理を終了します。"); // プログラム終了のメッセージをコンソールに表示
        }
    }

    // CSVのフィールドをエスケープするヘルパー関数
    static string EscapeCsvField(string field) // CSVの1つのフィールド (セル) の値を安全な形式に変換するメソッド
    {
        if (string.IsNullOrEmpty(field)) // フィールドがnullまたは空文字列の場合
        {
            return ""; // 空文字列をそのまま返す
        }
        // フィールドにカンマ、ダブルクォート、改行が含まれる場合はダブルクォートで囲む
        // フィールド内にCSVの特殊文字 (カンマ、ダブルクォート、改行) が含まれているかチェック
        if (field.Contains(",") || field.Contains("\"") || field.Contains("\n") || field.Contains("\r")) 
        {
            // ダブルクォート自体は二重にする
            // フィールド全体をダブルクォートで囲み、フィールド内のダブルクォートは2つ重ねる ("" に置換)
            return "\"" + field.Replace("\"", "\"\"") + "\""; 
        }
        return field; // 特殊文字が含まれていなければ、フィールドをそのまま返す
    }
}
