# Private gate bridge. Local RemoteSigned execution only: no policy override,
# installation, named job, PID lookup or shared process termination.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class V2VerifiedReadJob {
    [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reservedBytes;
        public IntPtr reservedPointer,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime,jobTime; public uint flags; public UIntPtr minimum,maximum;
        public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
    }
    [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit info,uint size);
    [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr returned);
    [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref UIntPtr size);
    [DllImport("kernel32", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInfo info);
    [DllImport("kernel32", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security security,uint size);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32", SetLastError=true)] static extern bool ReadFile(IntPtr handle,byte[] bytes,uint count,out uint read,IntPtr overlapped);
    [DllImport("kernel32", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
    static readonly object outputLock = new object();
    static int stopCode; static bool streamFailure;
    static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Emit(string json) { lock(outputLock) { Console.Out.WriteLine(json); Console.Out.Flush(); } }
    static string ReadText() { return Encoding.UTF8.GetString(Convert.FromBase64String(Console.In.ReadLine())); }
    // Windows argv quoting, never a shell command. lpApplicationName is the
    // exact current Node executable separately from this argument buffer.
    static string Quote(string value) {
        var result=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) { if(c=='\\') { slashes++; continue; }
            if(c=='\"') result.Append('\\',slashes*2+1); else result.Append('\\',slashes);
            slashes=0; result.Append(c);
        }
        result.Append('\\',slashes*2); return result.Append('"').ToString();
    }
    static Thread Drain(IntPtr pipe,string kind) {
        var thread=new Thread(()=> {
            try { var bytes=new byte[8192]; uint count;
                while(ReadFile(pipe,bytes,(uint)bytes.Length,out count,IntPtr.Zero)) {
                    if(count==0) break;
                    Emit("{\"kind\":\""+kind+"\",\"bytes\":\""+Convert.ToBase64String(bytes,0,(int)count)+"\"}");
                }
                int error=Marshal.GetLastWin32Error(); if(error!=0 && error!=109) streamFailure=true;
            } catch { streamFailure=true; }
            finally { CloseHandle(pipe); }
        }); thread.IsBackground=true; thread.Start(); return thread;
    }
    static uint Active(IntPtr job) { Accounting info; Check(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return info.active; }
    public static int Run() {
        IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobValue=IntPtr.Zero,handleValue=IntPtr.Zero;
        IntPtr outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,nul=IntPtr.Zero;
        ProcessInfo process=new ProcessInfo(); bool listInitialized=false;
        try {
            job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
            var limits=new ExtendedLimit(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, neither breakaway flag.
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))));
            // Compiler/bootstrap time is charged by the Node controller. Only
            // after this ready frame does it supply its monotonic remainder.
            Emit("{\"kind\":\"ready\"}");
            string executable=ReadText(),directory=ReadText();
            int remaining=int.Parse(Console.In.ReadLine()),initialStop=int.Parse(Console.In.ReadLine()),count=int.Parse(Console.In.ReadLine());
            var command=new StringBuilder(Quote(executable));
            for(int i=0;i<count;i++) command.Append(' ').Append(Quote(ReadText()));
            if(initialStop!=0 || remaining<=0) {
                Check(Active(job)==0); Emit("{\"kind\":\"closure\",\"nativeCode\":"+(initialStop!=0?initialStop:124)+",\"activeProcesses\":0}"); return 0;
            }
            var clock=Stopwatch.StartNew();
            var control=new Thread(()=> { try { string line=Console.In.ReadLine(); int code;
                if(line==null) Interlocked.CompareExchange(ref stopCode,1,0);
                else if(int.TryParse(line,out code) && (code==124 || code==130)) Interlocked.CompareExchange(ref stopCode,code,0);
                else Interlocked.CompareExchange(ref stopCode,1,0);
            } catch { Interlocked.CompareExchange(ref stopCode,1,0); } }); control.IsBackground=true; control.Start();
            var security=new Security(); security.length=Marshal.SizeOf(typeof(Security)); security.inherit=1;
            Check(CreatePipe(out outRead,out outWrite,ref security,0)); Check(SetHandleInformation(outRead,1,0));
            Check(CreatePipe(out errRead,out errWrite,ref security,0)); Check(SetHandleInformation(errRead,1,0));
            nul=CreateFileW("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(nul!=new IntPtr(-1));
            UIntPtr size=UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
            list=Marshal.AllocHGlobal((int)size.ToUInt64()); Check(InitializeProcThreadAttributeList(list,2,0,ref size)); listInitialized=true;
            jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job);
            Check(UpdateProcThreadAttribute(list,0,new UIntPtr(0x2000D),jobValue,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
            handleValue=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handleValue,0,nul); Marshal.WriteIntPtr(handleValue,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handleValue,IntPtr.Size*2,errWrite);
            Check(UpdateProcThreadAttribute(list,0,new UIntPtr(0x20002),handleValue,new UIntPtr((uint)(IntPtr.Size*3)),IntPtr.Zero,IntPtr.Zero));
            var startup=new StartupEx(); startup.startup.cb=Marshal.SizeOf(typeof(StartupEx)); startup.startup.flags=0x100;
            startup.startup.input=nul; startup.startup.output=outWrite; startup.startup.error=errWrite; startup.attributes=list;
            // JOB_LIST atomically assigns at creation: no suspended orphan gap.
            Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,directory,ref startup,out process));
            Emit("{\"kind\":\"started\"}");
            CloseHandle(process.thread); process.thread=IntPtr.Zero;
            CloseHandle(outWrite); outWrite=IntPtr.Zero; CloseHandle(errWrite); errWrite=IntPtr.Zero; CloseHandle(nul); nul=IntPtr.Zero;
            var stdout=Drain(outRead,"stdout"); outRead=IntPtr.Zero; var stderr=Drain(errRead,"stderr"); errRead=IntPtr.Zero;
            bool terminated=false,reportedExit=false; long cleanupEnd=0; uint result=0;
            while(true) {
                bool exited=WaitForSingleObject(process.process,0)==0; uint native=0;
                if(exited) Check(GetExitCodeProcess(process.process,out native));
                uint active=Active(job);
                if(exited && !reportedExit) {
                    Emit("{\"kind\":\"direct-exit\",\"nativeCode\":"+native+",\"activeProcesses\":"+active+"}"); reportedExit=true;
                }
                int stopping=Volatile.Read(ref stopCode);
                if(stopping==0 && clock.ElapsedMilliseconds>=remaining) stopping=124;
                if(!terminated && (stopping!=0 || (exited && native!=0 && active!=0))) {
                    result=stopping!=0?(uint)stopping:native; cleanupEnd=clock.ElapsedMilliseconds+5000;
                    Check(TerminateJobObject(job,result)); terminated=true;
                }
                if(exited && active==0 && !stdout.IsAlive && !stderr.IsAlive) {
                    if(streamFailure) throw new InvalidOperationException("stage output drainage failed");
                    result=terminated?result:native;
                    Emit("{\"kind\":\"closure\",\"nativeCode\":"+result+",\"activeProcesses\":0}"); return 0;
                }
                if(terminated && clock.ElapsedMilliseconds>=cleanupEnd) throw new TimeoutException("owned Job closure unconfirmed");
                Thread.Sleep(5);
            }
        } catch(Exception error) { Console.Error.WriteLine("VERIFIED_READ_JOB_UNCONFIRMED: "+error.Message); return 1; }
        finally {
            if(process.thread!=IntPtr.Zero) CloseHandle(process.thread);
            if(process.process!=IntPtr.Zero) CloseHandle(process.process);
            if(job!=IntPtr.Zero) CloseHandle(job); // kill-on-close is containment, NOT a closure proof.
            foreach(IntPtr handle in new[]{outRead,outWrite,errRead,errWrite,nul}) if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle);
            if(listInitialized) DeleteProcThreadAttributeList(list);
            foreach(IntPtr memory in new[]{list,jobValue,handleValue}) if(memory!=IntPtr.Zero) Marshal.FreeHGlobal(memory);
        }
    }
}
'@
exit [V2VerifiedReadJob]::Run()
