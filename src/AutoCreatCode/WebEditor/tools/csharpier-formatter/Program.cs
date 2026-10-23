using System.Text;
using CSharpier.Core.CSharp;

Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

var source = await Console.In.ReadToEndAsync();
var result = CSharpFormatter.Format(source);
if (result.ErrorDiagnostics.Any())
{
    Console.Error.WriteLine(string.Join(Environment.NewLine, result.ErrorDiagnostics));
    return 2;
}

await Console.Out.WriteAsync(result.Code);
return 0;
