using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

internal static class CodexRemoteCliShim
{
    private static Dictionary<string, string> ReadConfig(string path)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
            var split = line.IndexOf('=');
            if (split <= 0) continue;
            values[line.Substring(0, split).Trim()] = line.Substring(split + 1).Trim();
        }
        return values;
    }

    private static string Quote(string value)
    {
        if (value == null) return "\"\"";
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        var directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        var configPath = Path.Combine(directory, "codex-remote-shim.ini");
        if (!File.Exists(configPath))
        {
            Console.Error.WriteLine("Codex Remote CLI shim configuration is missing.");
            return 127;
        }

        var config = ReadConfig(configPath);
        string node;
        string proxy;
        string realCodex;
        string endpointFile;
        string log;
        config.TryGetValue("node", out node);
        config.TryGetValue("proxy", out proxy);
        config.TryGetValue("realCodex", out realCodex);
        config.TryGetValue("endpointFile", out endpointFile);
        config.TryGetValue("log", out log);
        if (String.IsNullOrWhiteSpace(node) || !File.Exists(node) ||
            String.IsNullOrWhiteSpace(proxy) || !File.Exists(proxy))
        {
            Console.Error.WriteLine("Codex Remote CLI shim runtime is incomplete.");
            return 127;
        }

        var arguments = new List<string>();
        arguments.Add(Quote(proxy));
        foreach (var argument in args) arguments.Add(Quote(argument));
        var start = new ProcessStartInfo(node, String.Join(" ", arguments.ToArray()))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = directory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            start.EnvironmentVariables[entry.Key.ToString()] = entry.Value == null ? null : entry.Value.ToString();
        }
        if (!String.IsNullOrWhiteSpace(realCodex)) start.EnvironmentVariables["CODEX_REMOTE_REAL_CODEX"] = realCodex;
        if (!String.IsNullOrWhiteSpace(endpointFile)) start.EnvironmentVariables["CODEX_REMOTE_APP_SERVER_ENDPOINT_FILE"] = endpointFile;
        if (!String.IsNullOrWhiteSpace(log)) start.EnvironmentVariables["CODEX_REMOTE_SHIM_LOG"] = log;

        var child = Process.Start(start);
        if (child == null)
        {
            Console.Error.WriteLine("Codex Remote CLI shim failed to start.");
            return 127;
        }
        try
        {
            var utf8 = new UTF8Encoding(false);
            var input = PumpLinesAsync(
                new StreamReader(Console.OpenStandardInput(), utf8, false, 4096, false),
                new StreamWriter(child.StandardInput.BaseStream, utf8) { AutoFlush = true });
            var output = PumpLinesAsync(
                new StreamReader(child.StandardOutput.BaseStream, utf8, false, 4096, false),
                new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true });
            var error = PumpLinesAsync(
                new StreamReader(child.StandardError.BaseStream, utf8, false, 4096, false),
                new StreamWriter(Console.OpenStandardError(), utf8) { AutoFlush = true });
            child.WaitForExit();
            try { Task.WaitAll(new[] { output, error }, 2000); } catch { /* Pipe closed. */ }
            return child.ExitCode;
        }
        finally
        {
            child.Dispose();
        }
    }

    private static Task PumpLinesAsync(TextReader source, TextWriter destination)
    {
        return Task.Run(() =>
        {
            try
            {
                string line;
                while ((line = source.ReadLine()) != null)
                {
                    destination.WriteLine(line);
                    destination.Flush();
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        });
    }
}
