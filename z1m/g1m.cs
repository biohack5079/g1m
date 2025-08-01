using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Drawing;
using System.Linq;
using System.Text;
// using System.Threading.Tasks; // C# 5 では Task関連の非同期処理がメインでなければ不要な場合あり
using System.Windows.Forms;
using Outlook = Microsoft.Office.Interop.Outlook;
using Word = Microsoft.Office.Interop.Word; // Word操作のため追加
using System.Runtime.InteropServices;
using System.IO; // Pathクラスなどのため追加

namespace OutlookCsvExporter
{
    // Outlookの予定情報を保持するためのシンプルなクラス
    // COMオブジェクトから独立させることで、AI処理などの拡張が容易になります
    public class AppointmentData
    {
        public string Subject { get; set; }
        public DateTime Start { get; set; }
        public DateTime End { get; set; }
        public string Location { get; set; }
        public bool AllDayEvent { get; set; }
        public string BodyPreview { get; set; } // 本文プレビューも追加する場合
        // 必要に応じて他のプロパティも追加
    }

    public partial class OutlookCsvForm : Form
    {
        // UIコントロールの宣言
        private System.Windows.Forms.Label lblCsvPath;
        private System.Windows.Forms.TextBox txtCsvPath;
        private System.Windows.Forms.Button btnBrowse;
        private System.Windows.Forms.Button btnExport;
        private System.Windows.Forms.TextBox txtLog;
        private System.Windows.Forms.Label lblLog;

        private System.Windows.Forms.Label lblWordTemplatePath;
        private System.Windows.Forms.TextBox txtWordTemplatePath;
        private System.Windows.Forms.Button btnBrowseWordTemplate;
        private System.Windows.Forms.Label lblYear;
        private System.Windows.Forms.NumericUpDown numericUpDownYear;
        private System.Windows.Forms.Button btnExportToWord;


        public OutlookCsvForm()
        {
            // InitializeComponent(); // デザイナ生成メソッド。手動でUI作成する場合は不要な場合もある
            InitializeCustomComponents(); // UIコントロールの初期化をここに集約
            txtLog.ScrollBars = ScrollBars.Vertical;
            numericUpDownYear.Minimum = 1900;
            numericUpDownYear.Maximum = 2100;
            numericUpDownYear.Value = DateTime.Now.Year; // デフォルト値を当年に
        }

        // UIコントロールを手動で初期化・配置するメソッド
        private void InitializeCustomComponents()
        {
            // CSV出力関連
            this.lblCsvPath = new System.Windows.Forms.Label();
            this.txtCsvPath = new System.Windows.Forms.TextBox();
            this.btnBrowse = new System.Windows.Forms.Button();
            this.btnExport = new System.Windows.Forms.Button();

            // Word出力関連
            this.lblWordTemplatePath = new System.Windows.Forms.Label();
            this.txtWordTemplatePath = new System.Windows.Forms.TextBox();
            this.btnBrowseWordTemplate = new System.Windows.Forms.Button();
            this.lblYear = new System.Windows.Forms.Label();
            this.numericUpDownYear = new System.Windows.Forms.NumericUpDown();
            this.btnExportToWord = new System.Windows.Forms.Button();

            // ログ関連
            this.txtLog = new System.Windows.Forms.TextBox();
            this.lblLog = new System.Windows.Forms.Label();

            // SuspendLayout/ResumeLayout はコントロールを多数追加する場合にパフォーマンス向上
            ((System.ComponentModel.ISupportInitialize)(this.numericUpDownYear)).BeginInit();
            this.SuspendLayout();

            // lblCsvPath
            this.lblCsvPath.AutoSize = true;
            this.lblCsvPath.Location = new System.Drawing.Point(12, 15);
            this.lblCsvPath.Name = "lblCsvPath";
            this.lblCsvPath.Size = new System.Drawing.Size(86, 12);
            this.lblCsvPath.Text = "CSV出力先:";
            // txtCsvPath
            this.txtCsvPath.Location = new System.Drawing.Point(104, 12);
            this.txtCsvPath.Name = "txtCsvPath";
            this.txtCsvPath.Size = new System.Drawing.Size(380, 19);
            this.txtCsvPath.TabIndex = 0;
            // btnBrowse
            this.btnBrowse.Location = new System.Drawing.Point(490, 10);
            this.btnBrowse.Name = "btnBrowse";
            this.btnBrowse.Size = new System.Drawing.Size(75, 23);
            this.btnBrowse.TabIndex = 1;
            this.btnBrowse.Text = "参照...";
            this.btnBrowse.UseVisualStyleBackColor = true;
            this.btnBrowse.Click += new System.EventHandler(this.btnBrowse_Click);
            // btnExport
            this.btnExport.Location = new System.Drawing.Point(571, 10);
            this.btnExport.Name = "btnExport";
            this.btnExport.Size = new System.Drawing.Size(100, 23);
            this.btnExport.TabIndex = 2;
            this.btnExport.Text = "CSVエクスポート";
            this.btnExport.UseVisualStyleBackColor = true;
            this.btnExport.Click += new System.EventHandler(this.btnExport_Click);

            // lblWordTemplatePath
            this.lblWordTemplatePath.AutoSize = true;
            this.lblWordTemplatePath.Location = new System.Drawing.Point(12, 45);
            this.lblWordTemplatePath.Name = "lblWordTemplatePath";
            this.lblWordTemplatePath.Size = new System.Drawing.Size(89, 12);
            this.lblWordTemplatePath.Text = "Wordテンプレート:";
            // txtWordTemplatePath
            this.txtWordTemplatePath.Location = new System.Drawing.Point(104, 42);
            this.txtWordTemplatePath.Name = "txtWordTemplatePath";
            this.txtWordTemplatePath.Size = new System.Drawing.Size(380, 19);
            this.txtWordTemplatePath.TabIndex = 3;
            // btnBrowseWordTemplate
            this.btnBrowseWordTemplate.Location = new System.Drawing.Point(490, 40);
            this.btnBrowseWordTemplate.Name = "btnBrowseWordTemplate";
            this.btnBrowseWordTemplate.Size = new System.Drawing.Size(75, 23);
            this.btnBrowseWordTemplate.TabIndex = 4;
            this.btnBrowseWordTemplate.Text = "参照...";
            this.btnBrowseWordTemplate.UseVisualStyleBackColor = true;
            this.btnBrowseWordTemplate.Click += new System.EventHandler(this.btnBrowseWordTemplate_Click);
            // lblYear
            this.lblYear.AutoSize = true;
            this.lblYear.Location = new System.Drawing.Point(12, 75);
            this.lblYear.Name = "lblYear";
            this.lblYear.Size = new System.Drawing.Size(47, 12);
            this.lblYear.Text = "対象年:";
            // numericUpDownYear
            this.numericUpDownYear.Location = new System.Drawing.Point(104, 73);
            this.numericUpDownYear.Name = "numericUpDownYear";
            this.numericUpDownYear.Size = new System.Drawing.Size(70, 19);
            this.numericUpDownYear.TabIndex = 5;
            // btnExportToWord
            this.btnExportToWord.Location = new System.Drawing.Point(190, 70);
            this.btnExportToWord.Name = "btnExportToWord";
            this.btnExportToWord.Size = new System.Drawing.Size(130, 23);
            this.btnExportToWord.TabIndex = 6;
            this.btnExportToWord.Text = "Wordカレンダー出力";
            this.btnExportToWord.UseVisualStyleBackColor = true;
            this.btnExportToWord.Click += new System.EventHandler(this.btnExportToWord_Click);

            // lblLog
            this.lblLog.AutoSize = true;
            this.lblLog.Location = new System.Drawing.Point(12, 110);
            this.lblLog.Name = "lblLog";
            this.lblLog.Size = new System.Drawing.Size(29, 12);
            this.lblLog.Text = "ログ:";
            // txtLog
            this.txtLog.Location = new System.Drawing.Point(12, 128);
            this.txtLog.Multiline = true;
            this.txtLog.Name = "txtLog";
            this.txtLog.ReadOnly = true;
            this.txtLog.ScrollBars = System.Windows.Forms.ScrollBars.Vertical;
            this.txtLog.Size = new System.Drawing.Size(659, 180);
            this.txtLog.TabIndex = 7;

            // Form
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 12F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(684, 321); // Window size
            this.Controls.Add(this.lblCsvPath);
            this.Controls.Add(this.txtCsvPath);
            this.Controls.Add(this.btnBrowse);
            this.Controls.Add(this.btnExport);
            this.Controls.Add(this.lblWordTemplatePath);
            this.Controls.Add(this.txtWordTemplatePath);
            this.Controls.Add(this.btnBrowseWordTemplate);
            this.Controls.Add(this.lblYear);
            this.Controls.Add(this.numericUpDownYear);
            this.Controls.Add(this.btnExportToWord);
            this.Controls.Add(this.lblLog);
            this.Controls.Add(this.txtLog);
            this.Name = "OutlookCsvForm";
            this.Text = "Outlook予定エクスポート";
            ((System.ComponentModel.ISupportInitialize)(this.numericUpDownYear)).EndInit();
            this.ResumeLayout(false);
            this.PerformLayout();
        }


        private void LogMessage(string message)
        {
            if (txtLog.InvokeRequired)
            {
                txtLog.Invoke(new Action<string>(LogMessage), message);
            }
            else
            {
                txtLog.AppendText(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " - " + message + Environment.NewLine);
            }
        }

        private void btnBrowse_Click(object sender, EventArgs e)
        {
            using (SaveFileDialog sfd = new SaveFileDialog())
            {
                sfd.Filter = "CSVファイル (*.csv)|*.csv";
                sfd.Title = "CSVファイルの保存先を選択";
                if (sfd.ShowDialog() == DialogResult.OK)
                {
                    txtCsvPath.Text = sfd.FileName;
                }
            }
        }

        private void btnExport_Click(object sender, EventArgs e)
        {
            if (string.IsNullOrWhiteSpace(txtCsvPath.Text))
            {
                MessageBox.Show("CSVファイルの出力先を指定してください。", "エラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            try
            {
                LogMessage("CSVエクスポート処理を開始します...");
                ExportOutlookDataToCsv(txtCsvPath.Text);
                LogMessage("CSVエクスポート処理が完了しました。");
                MessageBox.Show("CSVファイルへのエクスポートが完了しました。", "完了", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("CSVエクスポート中にエラーが発生しました: {0}\nスタックトレース: {1}", ex.Message, ex.StackTrace));
                MessageBox.Show(string.Format("エラーが発生しました: {0}", ex.Message), "エラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ExportOutlookDataToCsv(string filePath)
        {
            Outlook.Application outlookApp = null;
            Outlook.NameSpace outlookNs = null;
            Outlook.MAPIFolder calendarFolder = null;
            Outlook.Items calendarItems = null;
            // Outlook.Items restrictedItems = null; // フィルタリングする場合に使う

            try
            {
                outlookApp = new Outlook.Application();
                outlookNs = outlookApp.GetNamespace("MAPI");
                calendarFolder = outlookNs.GetDefaultFolder(Outlook.OlDefaultFolders.olFolderCalendar);
                calendarItems = calendarFolder.Items;

                // 全期間を出力する場合
                calendarItems.IncludeRecurrences = true;
                calendarItems.Sort("[Start]", false); // 開始日時で昇順ソート
                Outlook.Items currentItemsToProcess = calendarItems;


                List<string> csvLines = new List<string>();
                csvLines.Add("件名,開始日時,終了日時,場所,終日イベント,本文プレビュー");

                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("処理対象の予定アイテム数 (ソート・定期展開後): {0}", currentItemsToProcess.Count));
                int processedCount = 0;

                foreach (object itemObj in currentItemsToProcess)
                {
                    // C# 5 互換: パターンマッチングを as と null チェックに変更
                    Outlook.AppointmentItem apptItem = itemObj as Outlook.AppointmentItem;
                    if (apptItem != null)
                    {
                        try
                        {
                            string subject = apptItem.Subject ?? "";
                            string startTime = apptItem.Start.ToString("yyyy/MM/dd HH:mm");
                            string endTime = apptItem.End.ToString("yyyy/MM/dd HH:mm");
                            string location = apptItem.Location ?? "";
                            string allDay = apptItem.AllDayEvent ? "はい" : "いいえ";
                            string bodyPreview = (apptItem.Body != null && apptItem.Body.Length > 100) ? apptItem.Body.Substring(0, 100).Replace("\r\n", " ").Replace("\n", " ") + "..." : (apptItem.Body ?? "").Replace("\r\n", " ").Replace("\n", " ");

                            // C# 5 互換: 文字列補間を string.Format に変更
                            csvLines.Add(string.Format("\"{0}\",\"{1}\",\"{2}\",\"{3}\",\"{4}\",\"{5}\"",
                                subject.Replace("\"", "\"\""),
                                startTime,
                                endTime,
                                location.Replace("\"", "\"\""),
                                allDay,
                                bodyPreview.Replace("\"", "\"\"")));
                            processedCount++;
                        }
                        finally
                        {
                            Marshal.ReleaseComObject(apptItem); // 個々のアイテムを解放
                        }
                    }
                    else
                    {
                        if (itemObj != null && Marshal.IsComObject(itemObj)) // itemObjがCOMオブジェクトの場合のみ解放
                        {
                            Marshal.ReleaseComObject(itemObj); // AppointmentItemでない場合も解放
                        }
                    }
                }
                File.WriteAllLines(filePath, csvLines, Encoding.UTF8);
                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("{0} 件の予定をCSVに出力しました。", processedCount));
            }
            finally
            {
                // if (restrictedItems != null) Marshal.ReleaseComObject(restrictedItems); // フィルタリングした場合
                if (calendarItems != null) Marshal.ReleaseComObject(calendarItems);
                if (calendarFolder != null) Marshal.ReleaseComObject(calendarFolder);
                if (outlookNs != null) Marshal.ReleaseComObject(outlookNs);
                if (outlookApp != null) Marshal.ReleaseComObject(outlookApp);
            }
        }


        // --- Word出力関連 ---
        private void btnBrowseWordTemplate_Click(object sender, EventArgs e)
        {
            using (OpenFileDialog ofd = new OpenFileDialog())
            {
                ofd.Filter = "Word文書 (*.docx)|*.docx|Word 97-2003 文書 (*.doc)|*.doc";
                ofd.Title = "Wordカレンダーテンプレートを選択";
                if (ofd.ShowDialog() == DialogResult.OK)
                {
                    txtWordTemplatePath.Text = ofd.FileName;
                }
            }
        }

        private void btnExportToWord_Click(object sender, EventArgs e)
        {
            string templatePath = txtWordTemplatePath.Text;
            int year = (int)numericUpDownYear.Value;

            if (string.IsNullOrEmpty(templatePath) || !File.Exists(templatePath))
            {
                MessageBox.Show("有効なWordテンプレートファイルのパスを指定してください。", "エラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            string outputDirectory = Path.GetDirectoryName(templatePath);
            // C# 5 互換: 文字列補間を string.Format に変更
            string outputFileName = string.Format("{0}_{1}_output.docx", Path.GetFileNameWithoutExtension(templatePath), year);
            string outputPath = Path.Combine(outputDirectory, outputFileName);

            try
            {
                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("Outlookから {0} 年の予定を取得開始...", year));
                List<AppointmentData> appointments = GetOutlookAppointmentsForYear(year);

                if (appointments == null)
                {
                    // C# 5 互換: 文字列補間を string.Format に変更
                    MessageBox.Show(string.Format("{0} 年の予定取得中にエラーが発生しました。詳細はログを確認してください。", year), "エラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                if (appointments.Count == 0)
                {
                    // C# 5 互換: 文字列補間を string.Format に変更
                    LogMessage(string.Format("{0} 年に予定は見つかりませんでした。", year));
                }
                else
                {
                    // C# 5 互換: 文字列補間を string.Format に変更
                    LogMessage(string.Format("{0} 件の予定を取得しました。", appointments.Count));
                }

                // --- ここにAI処理を挟む拡張ポイント ---
                // 例: List<AppointmentData> processedAppointments = AiModule.ProcessAppointments(appointments);
                // その後、ExportCalendarToWord には processedAppointments を渡す。
                // 現状は取得したデータをそのまま使用します。
                // ------------------------------------

                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("Wordテンプレート '{0}' への書き込みを開始します...", templatePath));
                ExportCalendarToWord(appointments, templatePath, outputPath);
                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("Wordカレンダーを '{0}' に出力しました。", outputPath));
                MessageBox.Show(string.Format("Wordカレンダーを {0} に出力しました。", outputPath), "成功", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (COMException comEx)
            {
                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("Word操作中にCOMエラーが発生しました: {0}\nエラーコード: {1}\nスタックトレース: {2}", comEx.Message, comEx.ErrorCode, comEx.StackTrace));
                MessageBox.Show(string.Format("Wordの操作中にエラーが発生しました。Wordが正しくインストールされているか、ファイルが他のプログラムで使用中でないか確認してください。\n詳細: {0}", comEx.Message), "COMエラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch (Exception ex)
            {
                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("Wordへのエクスポート中にエラーが発生しました: {0}\nスタックトレース: {1}", ex.Message, ex.StackTrace));
                MessageBox.Show(string.Format("Wordへのエクスポート中にエラーが発生しました: {0}", ex.Message), "エラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private List<AppointmentData> GetOutlookAppointmentsForYear(int year)
        {
            Outlook.Application outlookApp = null;
            Outlook.NameSpace outlookNs = null;
            Outlook.MAPIFolder calendarFolder = null;
            Outlook.Items outlookCalendarItems = null;
            Outlook.Items restrictedItems = null;
            List<AppointmentData> appointmentDataList = new List<AppointmentData>();

            try
            {
                outlookApp = new Outlook.Application();
                outlookNs = outlookApp.GetNamespace("MAPI");
                calendarFolder = outlookNs.GetDefaultFolder(Outlook.OlDefaultFolders.olFolderCalendar);
                outlookCalendarItems = calendarFolder.Items;

                DateTime startDate = new DateTime(year, 1, 1, 0, 0, 0);
                DateTime endDate = startDate.AddYears(1);

                // C# 5 互換: 文字列補間を string.Format に変更
                string filter = string.Format("[Start] >= '{0:MM/dd/yyyy HH:mm}' AND [Start] < '{1:MM/dd/yyyy HH:mm}'", startDate, endDate);
                LogMessage(string.Format("Outlook予定取得フィルタ (DASL): {0}", filter));

                restrictedItems = outlookCalendarItems.Restrict(filter);
                if (restrictedItems == null)
                {
                    LogMessage("予定のフィルタリング結果がnullです。");
                    return appointmentDataList; // 空のリストを返す
                }

                restrictedItems.IncludeRecurrences = true;
                restrictedItems.Sort("[Start]", false); // 開始日でソート (昇順)

                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("フィルタリング後の予定アイテム数: {0}", restrictedItems.Count));

                foreach (object itemObj in restrictedItems)
                {
                    // C# 5 互換: パターンマッチングを as と null チェックに変更
                    Outlook.AppointmentItem apptItem = itemObj as Outlook.AppointmentItem;
                    if (apptItem != null)
                    {
                        try
                        {
                            appointmentDataList.Add(new AppointmentData
                            {
                                Subject = apptItem.Subject ?? "",
                                Start = apptItem.Start,
                                End = apptItem.End,
                                Location = apptItem.Location ?? "",
                                AllDayEvent = apptItem.AllDayEvent,
                                BodyPreview = (apptItem.Body != null && apptItem.Body.Length > 50) ? apptItem.Body.Substring(0, 50).Replace("\r", " ").Replace("\n", " ").Trim() + "..." : (apptItem.Body ?? "").Replace("\r", " ").Replace("\n", " ").Trim()
                            });
                        }
                        finally
                        {
                            Marshal.ReleaseComObject(apptItem);
                        }
                    }
                    else
                    {
                        if (itemObj != null && Marshal.IsComObject(itemObj))
                        {
                            Marshal.ReleaseComObject(itemObj);
                        }
                    }
                }
                return appointmentDataList;
            }
            catch (COMException comEx)
            {
                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("Outlookからの予定取得中にCOMエラー: {0}\nエラーコード: {1}\nスタックトレース: {2}", comEx.Message, comEx.ErrorCode, comEx.StackTrace));
                MessageBox.Show(string.Format("Outlookのデータアクセス中にエラーが発生しました。\n詳細: {0}", comEx.Message), "Outlook COMエラー", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return null;
            }
            catch (Exception ex)
            {
                // C# 5 互換: 文字列補間を string.Format に変更
                LogMessage(string.Format("Outlookからの予定取得中に一般エラー: {0}\nスタックトレース: {1}", ex.Message, ex.StackTrace));
                return null;
            }
            finally
            {
                if (restrictedItems != null) Marshal.ReleaseComObject(restrictedItems);
                if (outlookCalendarItems != null) Marshal.ReleaseComObject(outlookCalendarItems);
                if (calendarFolder != null) Marshal.ReleaseComObject(calendarFolder);
                if (outlookNs != null) Marshal.ReleaseComObject(outlookNs);
                if (outlookApp != null) Marshal.ReleaseComObject(outlookApp);
            }
        }

        private void ExportCalendarToWord(List<AppointmentData> appointments, string templatePath, string outputPath)
        {
            Word.Application wordApp = null;
            Word.Document doc = null;
            object missing = System.Reflection.Missing.Value;

            try
            {
                wordApp = new Word.Application();
                // wordApp.Visible = true; // デバッグ時にWordの動作を確認したい場合はコメントを外す

                object readOnly = false;
                object isVisible = false; // Wordを非表示で操作

                doc = wordApp.Documents.Open(FileName: templatePath, ReadOnly: ref readOnly, Visible: ref isVisible);

                var eventsByDate = appointments
                    .GroupBy(appt => appt.Start.Date)
                    .ToDictionary(g => g.Key, g => g.ToList());

                foreach (var dateEntry in eventsByDate)
                {
                    DateTime date = dateEntry.Key;
                    List<AppointmentData> dailyAppointments = dateEntry.Value;

                    // C# 5 互換: 文字列補間を string.Format に変更
                    string bookmarkName = string.Format("Date_{0:yyyyMMdd}", date); // 例: Date_20240115
                    
                    if (doc.Bookmarks.Exists(bookmarkName))
                    {
                        Word.Bookmark bm = doc.Bookmarks[bookmarkName];
                        Word.Range range = bm.Range;
                        StringBuilder appointmentsTextBuilder = new StringBuilder();
                        foreach (var appt in dailyAppointments.OrderBy(a => a.Start)) // 日内の予定も開始時間でソート
                        {
                            // C# 5 互換: 文字列補間を string.Format に変更
                            string timeInfo = appt.AllDayEvent ? "終日" : string.Format("{0:HH:mm}-{1:HH:mm}", appt.Start, appt.End);
                            appointmentsTextBuilder.AppendLine(string.Format("{0} {1}", timeInfo, appt.Subject));
                        }
                        // 既存のテキストをクリアしてから新しいテキストを挿入
                        range.Text = ""; 
                        range.InsertAfter(appointmentsTextBuilder.ToString().TrimEnd('\r', '\n'));
                        // C# 5 互換: 文字列補間を string.Format に変更
                        LogMessage(string.Format("ブックマーク '{0}' に予定を書き込みました。", bookmarkName));
                    }
                    else
                    {
                        // C# 5 互換: 文字列補間を string.Format に変更
                        LogMessage(string.Format("ブックマーク '{0}' がテンプレートに見つかりません。この日付の予定はスキップされます。", bookmarkName));
                    }
                }
                doc.SaveAs2(FileName: outputPath);
            }
            finally
            {
                if (doc != null)
                {
                    object saveChanges = Word.WdSaveOptions.wdDoNotSaveChanges; // SaveAs2で保存済みのため
#pragma warning disable 467 // CS0467: メソッドとイベント間のあいまいさの警告を抑制
                    doc.Close(ref saveChanges, ref missing, ref missing);
#pragma warning restore 467
                    Marshal.ReleaseComObject(doc);
                    doc = null;
                }
#pragma warning disable 467 // CS0467: メソッドとイベント間のあいまいさの警告を抑制
                if (wordApp != null)
                {
                    wordApp.Quit(ref missing, ref missing, ref missing);
                    Marshal.ReleaseComObject(wordApp);
                    wordApp = null;
                }
            }
        }

        // Windows Forms アプリケーションのエントリーポイント
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new OutlookCsvForm());
        }
    }
}
