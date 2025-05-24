using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Office.Interop.Outlook;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms; // Windows Forms 名前空間を追加
using System.Drawing;       // Point, Sizeなどのために追加 (手動でUI作成する場合)

public class OutlookCsvForm : Form // Formクラスを継承
{
    private Button btnExport;
    private TextBox txtLog;

    public OutlookCsvForm()
    {
        InitializeComponent();
    }

    private void InitializeComponent()
    {
        this.btnExport = new Button();
        this.txtLog = new TextBox();

        // フォームの設定
        this.Text = "Outlook予定エクスポート";
        this.Size = new Size(500, 400);

        // エクスポートボタンの設定
        this.btnExport.Text = "Outlook予定をCSVにエクスポート";
        this.btnExport.Location = new Point(10, 10);
        this.btnExport.Size = new Size(460, 30);
        this.btnExport.Click += new EventHandler(this.btnExport_Click);

        // ログ表示用テキストボックスの設定
        this.txtLog.Location = new Point(10, 50);
        this.txtLog.Size = new Size(460, 280);
        this.txtLog.Multiline = true;
        this.txtLog.ScrollBars = ScrollBars.Vertical;
        this.txtLog.ReadOnly = true;

        // コントロールをフォームに追加
        this.Controls.Add(this.btnExport);
        this.Controls.Add(this.txtLog);
    }

    private void btnExport_Click(object sender, EventArgs e)
    {
        txtLog.Clear(); // ログをクリア
        LogMessage("処理を開始します...");
        this.btnExport.Enabled = false; // 処理中はボタンを無効化

        // Outlook処理は時間がかかる可能性があるので、本来は別スレッドで行うのが望ましいですが、
        // まずはシンプルにUIスレッドで実行します。
        // UIが一時的に応答しなくなる可能性がある点に注意してください。
        try
        {
            ExportOutlookData();
        }
        catch (System.Exception ex)
        {
            LogMessage("エラーが発生しました: " + ex.Message);
            LogMessage("スタックトレース: " + ex.StackTrace);
            MessageBox.Show("エラーが発生しました。\n詳細はログを確認してください。", "エラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            this.btnExport.Enabled = true; // ボタンを再度有効化
            LogMessage("処理を終了します。");
        }
    }

    private void ExportOutlookData()
    {
        Microsoft.Office.Interop.Outlook.Application outlookApp = null;        NameSpace outlookNs = null;
        MAPIFolder calendarFolder = null;
        Items calendarItems = null;

        try
        {
            string csvOutputDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string csvFileName = "OutlookCalendarExport.csv";
            string csvFilePath = Path.Combine(csvOutputDirectory, csvFileName);

            LogMessage(string.Format("Outlookカレンダーの情報を取得し、{0} に出力します...", csvFilePath));

            outlookApp = new Microsoft.Office.Interop.Outlook.Application();
            outlookNs = outlookApp.GetNamespace("MAPI");
            calendarFolder = outlookNs.GetDefaultFolder(OlDefaultFolders.olFolderCalendar);
            calendarItems = calendarFolder.Items;

            calendarItems.IncludeRecurrences = true;
            calendarItems.Sort("[Start]", false);

            List<string> csvLines = new List<string>();
            csvLines.Add("件名,開始日時,終了日時,場所,終日イベント,本文プレビュー");

            LogMessage(string.Format("処理対象の予定アイテム数: {0}", calendarItems.Count));
            int processedCount = 0;

            foreach (object itemObj in calendarItems)
            {
                AppointmentItem apptItem = itemObj as AppointmentItem;
                if (apptItem != null)
                {
                    try
                    {
                        string subject = EscapeCsvField(apptItem.Subject);
                        string start = apptItem.Start.ToString("yyyy-MM-dd HH:mm");
                        string end = apptItem.End.ToString("yyyy-MM-dd HH:mm");
                        string location = EscapeCsvField(apptItem.Location);
                        string allDayEvent = apptItem.AllDayEvent.ToString();
                        string bodyContent = apptItem.Body;
                        string rawBodyPreview = null;
                        if (bodyContent != null)
                        {
                            int actualLength = bodyContent.Length;
                            int lengthToTake = Math.Min(actualLength, 100);
                            rawBodyPreview = bodyContent.Substring(0, lengthToTake);
                            rawBodyPreview = rawBodyPreview.Replace("\r\n", " ").Replace("\n", " ").Replace("\r", " ");
                        }
                        string bodyPreview = EscapeCsvField(rawBodyPreview);
                        csvLines.Add(string.Format("{0},{1},{2},{3},{4},{5}", subject, start, end, location, allDayEvent, bodyPreview));
                        processedCount++;
                    }
                    finally
                    {
                        if (apptItem != null) Marshal.ReleaseComObject(apptItem);
                    }
                }
            }

            File.WriteAllLines(csvFilePath, csvLines, new UTF8Encoding(true));
            LogMessage(string.Format("{0} 件の予定を {1} に保存しました。", processedCount, csvFilePath));
            MessageBox.Show(string.Format("{0} 件の予定を\n{1}\nに保存しました。", processedCount, csvFilePath), "エクスポート完了", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        finally
        {
            if (calendarItems != null) Marshal.ReleaseComObject(calendarItems);
            if (calendarFolder != null) Marshal.ReleaseComObject(calendarFolder);
            if (outlookNs != null) Marshal.ReleaseComObject(outlookNs);
            if (outlookApp != null) Marshal.ReleaseComObject(outlookApp);
        }
    }

    private void LogMessage(string message)
    {
        if (txtLog.InvokeRequired) // 別スレッドからの呼び出しの場合
        {
            txtLog.Invoke(new Action<string>(LogMessage), message);
        }
        else
        {
            txtLog.AppendText(message + Environment.NewLine);
        }
    }

    static string EscapeCsvField(string field)
    {
        if (string.IsNullOrEmpty(field)) return "";
        if (field.Contains(",") || field.Contains("\"") || field.Contains("\n") || field.Contains("\r"))
            return "\"" + field.Replace("\"", "\"\"") + "\"";
        return field;
    }

    [STAThread] // Windows FormsアプリケーションにはSTAThread属性が必要
    static void Main()
    {
        System.Windows.Forms.Application.EnableVisualStyles();
        System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);
        System.Windows.Forms.Application.Run(new OutlookCsvForm()); // OutlookCsvForm を起動

    }
}