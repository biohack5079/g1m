VERSION 1.0 CLASS
BEGIN
  MultiUse = -1  'True
END
Attribute VB_Name = "Sheet1"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = True
Sub dainyuu()
    Dim table(2) As Integer
    table(0) = Range("A3").Value / 2
    table(1) = Range("A1") - Range("A2").Value
    Range("A1").Offset(table(0), table(1)).Value = Range("A1").Value + Range("A2").Value
    Range("C1").Value = Range("A3") - Range("A2").Value
    Range("B4").Offset(Range("C1").Value, table(1)) = Range("A4").Offset(0, Range("A5").Value)
End Sub
