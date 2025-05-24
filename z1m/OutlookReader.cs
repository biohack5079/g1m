using System;
using Microsoft.Office.Interop.Outlook;

class Program
{
    static void Main()
    {
        try
        {
            Application outlookApp = new Application();
            NameSpace outlookNs = outlookApp.GetNamespace("MAPI");
            MAPIFolder calendar = outlookNs.GetDefaultFolder(OlDefaultFolders.olFolderCalendar);
            Items items = calendar.Items;

            items.IncludeRecurrences = true;
            items.Sort("[Start]");

            Console.WriteLine("=== Outlook予定一覧 ===\n");

            foreach (object item in items)
            {
                AppointmentItem appt = item as AppointmentItem;
                if (appt != null)
                {
                    Console.WriteLine(string.Format("件名: {0}", appt.Subject));
                    Console.WriteLine(string.Format("開始: {0}", appt.Start));
                    Console.WriteLine(string.Format("終了: {0}", appt.End));
                    Console.WriteLine(new string('-', 30));
                }
            }
        }
        catch (System.Exception ex)
        {
            Console.WriteLine("エラーが発生しました: " + ex.Message);
        }
    }
}
