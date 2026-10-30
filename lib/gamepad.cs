// Virtual Xbox 360 controllers (via the ViGEmBus driver) fed from the laptop's gamepads.
// stdin lines:  s <slot> <buttons> <lt> <rt> <lx> <ly> <rx> <ry>   |   r <slot>
// stdout lines: f <slot> <large> <small>   (rumble for the laptop to play)
// exit code 3 = ViGEmBus driver is not installed.
using System;
using System.Collections.Generic;
using Nefarius.ViGEm.Client;
using Nefarius.ViGEm.Client.Targets;
using Nefarius.ViGEm.Client.Targets.Xbox360;

static class Program {
    static readonly object outLock = new object();

    static int Main() {
        ViGEmClient client;
        try { client = new ViGEmClient(); }
        catch (Exception) { return 3; }

        var pads = new Dictionary<int, IXbox360Controller>();
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            int start = 0;
            while (start < line.Length && line[start] > 127) start++; // stray BOM decoded in the console codepage
            var p = line.Substring(start).Trim().Split(' ');
            int slot;
            if (p.Length < 2 || !int.TryParse(p[1], out slot) || slot < 0 || slot > 3) continue;
            if (p[0] == "r") {
                IXbox360Controller gone;
                if (pads.TryGetValue(slot, out gone)) { gone.Disconnect(); pads.Remove(slot); }
                continue;
            }
            if (p[0] != "s" || p.Length != 9) continue;
            IXbox360Controller pad;
            if (!pads.TryGetValue(slot, out pad)) {
                pad = client.CreateXbox360Controller();
                int s = slot;
                pad.FeedbackReceived += (o, e) => {
                    lock (outLock) { Console.Out.WriteLine("f " + s + " " + e.LargeMotor + " " + e.SmallMotor); Console.Out.Flush(); }
                };
                pad.AutoSubmitReport = false;
                try { pad.Connect(); }
                catch (Exception ex) { Console.Error.WriteLine("connect failed: " + ex.GetType().Name + ": " + ex.Message); continue; }
                Console.Error.WriteLine("connected slot " + slot);
                pads[slot] = pad;
            }
            try {
                pad.SetButtonsFull(ushort.Parse(p[2]));
                pad.SetSliderValue(Xbox360Slider.LeftTrigger, byte.Parse(p[3]));
                pad.SetSliderValue(Xbox360Slider.RightTrigger, byte.Parse(p[4]));
                pad.SetAxisValue(Xbox360Axis.LeftThumbX, short.Parse(p[5]));
                pad.SetAxisValue(Xbox360Axis.LeftThumbY, short.Parse(p[6]));
                pad.SetAxisValue(Xbox360Axis.RightThumbX, short.Parse(p[7]));
                pad.SetAxisValue(Xbox360Axis.RightThumbY, short.Parse(p[8]));
                pad.SubmitReport();
            } catch (FormatException) { } catch (OverflowException) { }
        }
        foreach (var pad in pads.Values) pad.Disconnect();
        return 0;
    }
}
