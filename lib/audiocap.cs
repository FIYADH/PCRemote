// WASAPI loopback capture of the default playback device -> raw 48 kHz 16-bit stereo PCM on stdout.
// Built once by lib/audio.js with the .NET Framework csc.exe that ships with Windows.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    int OpenPropertyStore(int access, out IntPtr props);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
    int Initialize(int mode, int flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
    int GetBufferSize(out int frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out int frames);
    int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long def, out long min);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr h);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out int frames, out int flags, out long devPos, out long qpc);
    int ReleaseBuffer(int frames);
    int GetNextPacketSize(out int frames);
}

static class Program {
    static int Main() {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        IMMDevice dev;
        if (enumerator.GetDefaultAudioEndpoint(0, 0, out dev) != 0) return 2;
        string id; dev.GetId(out id);

        Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        object o; dev.Activate(ref iidClient, 23, IntPtr.Zero, out o);
        var client = (IAudioClient)o;

        // WAVEFORMATEX: PCM, 2 ch, 48000 Hz, 16 bit
        IntPtr fmt = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(fmt, 0, 1);
        Marshal.WriteInt16(fmt, 2, 2);
        Marshal.WriteInt32(fmt, 4, 48000);
        Marshal.WriteInt32(fmt, 8, 48000 * 4);
        Marshal.WriteInt16(fmt, 12, 4);
        Marshal.WriteInt16(fmt, 14, 16);
        Marshal.WriteInt16(fmt, 16, 0);
        // loopback | autoconvert pcm | default-quality resampler
        int hr = client.Initialize(0, 0x00020000 | unchecked((int)0x80000000) | 0x08000000, 200000, 0, fmt, IntPtr.Zero);
        if (hr != 0) return 3;
        Guid iidCap = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object c; client.GetService(ref iidCap, out c);
        var cap = (IAudioCaptureClient)c;
        client.Start();

        var stdout = Console.OpenStandardOutput();
        byte[] buf = new byte[0];
        int tick = 0;
        while (true) {
            int n; cap.GetNextPacketSize(out n);
            while (n > 0) {
                IntPtr data; int frames, flags; long pos, qpc;
                if (cap.GetBuffer(out data, out frames, out flags, out pos, out qpc) != 0) return 4;
                int bytes = frames * 4;
                if (buf.Length < bytes) buf = new byte[bytes];
                if ((flags & 2) != 0) Array.Clear(buf, 0, bytes); else Marshal.Copy(data, buf, 0, bytes);
                cap.ReleaseBuffer(frames);
                try { stdout.Write(buf, 0, bytes); stdout.Flush(); } catch (IOException) { return 0; }
                cap.GetNextPacketSize(out n);
            }
            Thread.Sleep(4);
            if (++tick % 500 == 0) { // ~2 s: follow the default output device if it changes
                IMMDevice d2; string id2;
                if (enumerator.GetDefaultAudioEndpoint(0, 0, out d2) != 0) return 0;
                d2.GetId(out id2);
                if (id2 != id) return 0;
            }
        }
    }
}
