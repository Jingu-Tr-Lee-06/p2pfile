"use client";

import { useState, useEffect, useRef } from "react";
import type Peer from "peerjs";
import type { DataConnection } from "peerjs";
import { nanoid } from "nanoid";
import Link from "next/link";

interface ManagedFile {
  id: string;
  file: File;
}

interface PeerTelemetry {
  publicIp: string;
  location: string;
  isp: string;
  candidateType: string;
  rtt: string;
  bytesSentTotal: number;
}

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 1024 * 1024;
const LOW_WATER_MARK = 256 * 1024;
const SESSION_TIMEOUT = 600;

export default function SenderPage() {
  const [fileList, setFileList] = useState<ManagedFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customRoomId, setCustomRoomId] = useState<string>("");
  const [shareUrl, setShareUrl] = useState<string>("");
  const [status, setStatus] = useState<string>("대기 중");
  const [timeLeft, setTimeLeft] = useState<number>(SESSION_TIMEOUT);
  const [speed, setSpeed] = useState<string>("0.0 MB/s");
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const [telemetry, setTelemetry] = useState<PeerTelemetry>({
    publicIp: "수신 대기 중...",
    location: "---",
    isp: "---",
    candidateType: "---",
    rtt: "---",
    bytesSentTotal: 0,
  });
  const [logs, setLogs] = useState<string[]>([]);

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const fileListRef = useRef<ManagedFile[]>([]);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  const sendQueueRef = useRef<{ fileToSend: File; fileId: string }[]>([]);
  const isStreamingRef = useRef<boolean>(false);

  fileListRef.current = fileList;

  useEffect(() => {
    setCustomRoomId(nanoid(6));
  }, []);

  const appendLog = (msg: string) => {
    const time = new Date().toTimeString().split(" ")[0];
    setLogs((prev) => [...prev, `[${time}] ${msg}`]);
  };

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (!shareUrl) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          peerRef.current?.destroy();
          setStatus("세션 만료");
          appendLog("WARN: 세션 10분 만료로 소켓이 파기되었습니다.");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [shareUrl]);

  useEffect(() => {
    if (!connRef.current) return;

    const interval = setInterval(async () => {
      const pc = (connRef.current as any)?.peerConnection as RTCPeerConnection;
      if (!pc || pc.connectionState !== "connected") return;

      try {
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded") {
            const remoteReport = stats.get(report.remoteCandidateId);
            if (remoteReport) {
              const candType = (remoteReport.candidateType || "host").toUpperCase();
              const rttMs = report.currentRoundTripTime
                ? `${Math.round(report.currentRoundTripTime * 1000)} ms`
                : "---";

              setTelemetry((prev) => ({
                ...prev,
                candidateType: candType,
                rtt: rttMs,
              }));
            }
          }
        });
      } catch {}
    }, 1000);

    return () => clearInterval(interval);
  }, [status]);

  const initSession = async (roomIdToUse: string) => {
    const targetId = roomIdToUse.trim();
    if (!targetId) {
      alert("공유 식별 코드를 입력하세요.");
      return;
    }

    if (peerRef.current) {
      peerRef.current.destroy();
      appendLog("SYSTEM: 기존 피어 소켓을 닫고 재할당을 진행합니다.");
    }

    appendLog(`SYSTEM: P2P 시그널링 채널 오픈 시도 (ID: ${targetId})...`);

    const { default: Peer } = await import("peerjs");
    const peer = new Peer(targetId);
    peerRef.current = peer;

    peer.on("open", (peerId) => {
      setShareUrl(`${window.location.origin}/receive#${peerId}`);
      setStatus("수신자 대기 중");
      setTimeLeft(SESSION_TIMEOUT);
      appendLog(`BROKER: 방 개설 성공 (SESSION_KEY: ${peerId})`);
      appendLog("LISTEN: 수신자의 인바운드 연결 대기 중...");
    });

    peer.on("connection", (conn) => {
      connRef.current = conn;
      setStatus("수신자 연결됨");

      conn.on("open", () => {
        appendLog(`CONN: 피어 접속 확인 (PEER_HASH: ${conn.peer})`);
        broadcastManifest(conn);
      });

      conn.on("data", async (data: any) => {
        if (data.type === "client_telemetry") {
          const { ip, country, city, isp } = data;
          setTelemetry((prev) => ({
            ...prev,
            publicIp: ip || "Unknown",
            location: `${city || ""}, ${country || ""}`.trim() || "정보 없음",
            isp: isp || "Unknown ISP",
          }));
          appendLog(`GEOIP: 수신자 공인 IP 식별 -> ${ip} (${city}, ${country})`);
          appendLog(`NETWORK: 수신자 통신사(ISP) -> ${isp}`);
        } else if (data.type === "request_file") {
          const target = fileListRef.current.find((f) => f.id === data.fileId);
          if (target) {
            appendLog(`QUEUE: 다운로드 요청 등록 -> "${target.file.name}"`);
            sendQueueRef.current.push({ fileToSend: target.file, fileId: target.id });
            processSendQueue(conn);
          }
        }
      });

      conn.on("close", () => {
        appendLog("CONN_CLOSE: 수신자와의 데이터 채널이 종료되었습니다.");
        setStatus("연결 끊김");
        sendQueueRef.current = [];
        isStreamingRef.current = false;
      });
    });

    peer.on("error", (err: any) => {
      if (err.type === "unavailable-id") {
        alert("이미 사용 중인 공유 코드입니다. 다른 코드를 입력해 주세요.");
        appendLog(`ERROR: ID '${targetId}'는 이미 사용 중입니다.`);
        setShareUrl("");
      } else {
        appendLog(`ERROR: 피어 에러 발생 (${err.type})`);
      }
      setStatus("오류");
    });
  };

  const broadcastManifest = (conn: DataConnection) => {
    appendLog(`SYNC: 등록된 ${fileListRef.current.length}개 파일 메타데이터 전달`);
    conn.send({
      type: "manifest",
      files: fileListRef.current.map((item) => ({
        id: item.id,
        name: item.file.name,
        size: item.file.size,
        type: item.file.type,
      })),
    });
  };

  const handleAddFiles = (incoming: FileList | File[]) => {
    const newItems: ManagedFile[] = Array.from(incoming).map((file) => ({
      id: nanoid(6),
      file,
    }));
    setFileList((prev) => [...prev, ...newItems]);
    appendLog(`STORAGE: 신규 파일 ${newItems.length}개 등록`);

    if (!shareUrl) {
      initSession(customRoomId || nanoid(6));
    } else if (connRef.current?.open) {
      setTimeout(() => broadcastManifest(connRef.current!), 100);
    }
  };

  const handleDeleteSelected = () => {
    setFileList((prev) => prev.filter((item) => !selectedIds.includes(item.id)));
    appendLog(`STORAGE: 선택 파일 ${selectedIds.length}개 제거`);
    setSelectedIds([]);
    if (connRef.current?.open) {
      setTimeout(() => broadcastManifest(connRef.current!), 100);
    }
  };

  const handleDeleteAll = () => {
    setFileList([]);
    setSelectedIds([]);
    appendLog("STORAGE: 모든 공유 파일 초기화");
    if (connRef.current?.open) {
      setTimeout(() => broadcastManifest(connRef.current!), 100);
    }
  };

  const processSendQueue = async (conn: DataConnection) => {
    if (isStreamingRef.current || sendQueueRef.current.length === 0) return;
    isStreamingRef.current = true;

    while (sendQueueRef.current.length > 0) {
      const task = sendQueueRef.current.shift();
      if (task) {
        await streamFileSequentially(conn, task.fileToSend, task.fileId);
      }
    }

    isStreamingRef.current = false;
    setStatus("대기 중");
  };

  const streamFileSequentially = async (conn: DataConnection, fileToSend: File, fileId: string) => {
    setStatus(`${fileToSend.name} 전송 중`);
    const dc = (conn as any).dataChannel as RTCDataChannel;
    dc.bufferedAmountLowThreshold = LOW_WATER_MARK;

    const totalChunks = Math.ceil(fileToSend.size / CHUNK_SIZE);
    let bytesSentInterval = 0;
    let bytesSentFile = 0;
    const streamStartTime = performance.now();
    let lastTime = performance.now();
    let lastLogTime = performance.now();

    const totalMbStr = (fileToSend.size / 1024 / 1024).toFixed(2);
    appendLog(`STREAM_START: "${fileToSend.name}" 파이프라인 가동 (크기: ${totalMbStr} MB, 청크: ${totalChunks}개)`);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      if (dc.bufferedAmount >= HIGH_WATER_MARK) {
        await new Promise<void>((resolve) => {
          dc.onbufferedamountlow = () => {
            dc.onbufferedamountlow = null;
            resolve();
          };
        });
      }

      const offset = chunkIndex * CHUNK_SIZE;
      const slice = fileToSend.slice(offset, offset + CHUNK_SIZE);
      const arrayBuffer = await slice.arrayBuffer();

      conn.send({
        type: "file_chunk",
        fileId,
        index: chunkIndex,
        total: totalChunks,
        data: arrayBuffer,
      });

      bytesSentInterval += arrayBuffer.byteLength;
      bytesSentFile += arrayBuffer.byteLength;

      setTelemetry((prev) => ({
        ...prev,
        bytesSentTotal: prev.bytesSentTotal + arrayBuffer.byteLength,
      }));

      const now = performance.now();

      if (now - lastTime >= 200) {
        const calculatedSpeed = (
          bytesSentInterval /
          1024 /
          1024 /
          ((now - lastTime) / 1000)
        ).toFixed(1);
        setSpeed(`${calculatedSpeed} MB/s`);
        bytesSentInterval = 0;
        lastTime = now;
      }

      if (now - lastLogTime >= 300 || chunkIndex + 1 === totalChunks) {
        const currentSentMb = (bytesSentFile / 1024 / 1024).toFixed(2);
        const percent = Math.round(((chunkIndex + 1) / totalChunks) * 100);
        const elapsedSec = Math.max((now - streamStartTime) / 1000, 0.001);
        const currentSpeed = (bytesSentFile / 1024 / 1024 / elapsedSec).toFixed(1);

        appendLog(
          `DATA_OUT: [Chunk ${chunkIndex + 1}/${totalChunks}] ${percent}% (${currentSentMb}MB / ${totalMbStr}MB) @ ${currentSpeed} MB/s`
        );
        lastLogTime = now;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 60));

    const totalDurationSec = Math.max((performance.now() - streamStartTime) / 1000, 0.001);
    const averageSpeed = ((fileToSend.size / 1024 / 1024) / totalDurationSec).toFixed(1);
    setSpeed(`${averageSpeed} MB/s`);

    conn.send({ type: "file_done", fileId });
    appendLog(`STREAM_SUCCESS: "${fileToSend.name}" 완료 (총 ${totalMbStr} MB, 평균 ${averageSpeed} MB/s, ${totalDurationSec.toFixed(2)}초 소요)`);
  };

  const handleCopy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    appendLog("CLIPBOARD: 다운로드 링크 복사됨");
  };

  return (
    <div className="min-h-screen bg-[#f8fafd] text-[#1f1f1f] flex flex-col font-sans overflow-x-hidden">
      {/* 헤더: 설명서 버튼 + 모드 전환 토글 포함 */}
      <header className="h-16 border-b border-[#e1e3e1] bg-white px-4 sm:px-6 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center bg-[#e8f0fe] text-[#0b57d0] flex-shrink-0">
            <svg className="w-5 h-5 sm:w-6 sm:h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
            </svg>
          </div>
          <div className="truncate">
            <span className="text-base sm:text-lg font-medium text-[#1f1f1f]">Direct Drive</span>
            <span className="hidden xs:inline-block ml-1.5 sm:ml-2 text-[10px] sm:text-xs font-mono px-2 py-0.5 rounded-full bg-[#e8f0fe] text-[#0b57d0] font-medium">
              Send
            </span>
          </div>
        </div>

        {/* 헤더 우측: 사용 가이드 버튼 + 모드 전환 탭 */}
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <a
            href="https://com-study.notion.site/Direct-Drive-3ee29cd9f9d88050b8f6fd3f437962f0?source=copy_link"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl border border-[#c4c7c5] hover:border-[#0b57d0] hover:bg-[#e8f0fe] text-[#444746] hover:text-[#0b57d0] text-xs font-medium transition"
            title="사용 가이드 열기"
          >
            <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#0b57d0]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M12 18h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="hidden sm:inline">사용 가이드</span>
          </a>

          <div className="flex items-center bg-[#f1f3f4] p-0.5 sm:p-1 rounded-xl border border-[#e1e3e1]">
            <span className="px-2.5 sm:px-3 py-1 bg-white text-[#0b57d0] text-xs font-semibold rounded-lg shadow-sm">
              Send
            </span>
            <Link
              href="/receive"
              className="px-2.5 sm:px-3 py-1 text-[#444746] hover:text-[#1f1f1f] text-xs font-medium rounded-lg transition"
            >
              Receive
            </Link>
          </div>

          {shareUrl && (
            <div className="hidden md:flex text-xs font-mono text-[#444746] bg-[#f1f3f4] px-3 py-1.5 rounded-full items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#188038]" />
              <span>만료까지: {Math.floor(timeLeft / 60)}분 {timeLeft % 60}초</span>
            </div>
          )}
        </div>
      </header>

      {/* 메인 레이아웃 */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6 md:p-8 space-y-4 sm:space-y-6">
        {/* 1. 세션명 설정 패널 */}
        <div className="bg-white border border-[#e1e3e1] rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[#1f1f1f]">공유 세션명 (접속 코드) 설정</div>
            <div className="text-xs text-[#747775] mt-0.5 truncate">상대방에게 전달할 맞춤형 코드를 직접 입력하세요.</div>
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <span className="text-xs font-mono text-[#747775] flex-shrink-0">/receive#</span>
            <input
              type="text"
              value={customRoomId}
              onChange={(e) => setCustomRoomId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
              placeholder="코드 입력"
              className="bg-[#f8fafd] border border-[#c4c7c5] rounded-xl px-2.5 sm:px-3 py-2 text-xs font-mono flex-1 md:w-36 text-center font-bold text-[#0b57d0] focus:outline-none focus:border-[#0b57d0] min-w-0"
            />
            <button
              type="button"
              onClick={() => initSession(customRoomId)}
              className="px-3.5 sm:px-4 py-2 bg-[#0b57d0] hover:bg-[#0842a0] text-white text-xs font-medium rounded-xl transition shadow-sm whitespace-nowrap active:scale-95 flex-shrink-0"
            >
              {shareUrl ? "코드 변경" : "세션 열기"}
            </button>
          </div>
        </div>

        {/* 2. 세션 활성화 및 텔레메트리 모니터링 카드 */}
        {shareUrl && (
          <div className="bg-white border border-[#e1e3e1] rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-sm space-y-4 sm:space-y-5">
            <div className="flex flex-col gap-3 pb-4 border-b border-[#e1e3e1]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#188038] animate-pulse flex-shrink-0" />
                  <span className="text-xs sm:text-sm font-semibold text-[#1f1f1f] whitespace-nowrap">
                    터널 활성
                  </span>
                  <span className="text-xs text-[#747775] font-mono truncate max-w-[140px] sm:max-w-xs">
                    ({status})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#e8f0fe] text-[#0b57d0] font-bold whitespace-nowrap">
                    코드: {customRoomId}
                  </span>
                  <span className="md:hidden text-[11px] font-mono text-[#747775] bg-[#f1f3f4] px-2 py-0.5 rounded">
                    {Math.floor(timeLeft / 60)}:{String(timeLeft % 60).padStart(2, "0")}
                  </span>
                </div>
              </div>

              <div className="flex gap-2 w-full">
                <input
                  readOnly
                  value={shareUrl}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="bg-[#f8fafd] border border-[#c4c7c5] rounded-xl px-3 py-2 text-xs font-mono flex-1 min-w-0 truncate"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="px-3.5 sm:px-4 py-2 bg-[#0b57d0] hover:bg-[#0842a0] text-white text-xs font-medium rounded-xl transition shadow-sm whitespace-nowrap active:scale-95 flex-shrink-0"
                >
                  {copied ? "복사됨" : "링크 복사"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3 text-xs font-mono">
              <div className="p-3 bg-[#f8fafd] rounded-xl border border-[#e1e3e1] min-w-0">
                <div className="text-[10px] text-[#747775] uppercase truncate">전송 속도 / 누적량</div>
                <div className="text-sm font-semibold text-[#1f1f1f] mt-1 truncate">{speed}</div>
                <div className="text-[11px] text-[#747775] mt-0.5 truncate">
                  총 {(telemetry.bytesSentTotal / 1024 / 1024).toFixed(2)} MB
                </div>
              </div>

              <div className="p-3 bg-[#f8fafd] rounded-xl border border-[#e1e3e1] min-w-0">
                <div className="text-[10px] text-[#747775] uppercase truncate">수신자 공인 IP</div>
                <div className="text-sm font-semibold text-[#1f1f1f] mt-1 truncate break-all">
                  {telemetry.publicIp}
                </div>
                <div className="text-[11px] text-[#747775] mt-0.5 truncate">
                  타입: {telemetry.candidateType}
                </div>
              </div>

              <div className="p-3 bg-[#f8fafd] rounded-xl border border-[#e1e3e1] min-w-0">
                <div className="text-[10px] text-[#747775] uppercase truncate">수신자 위치 / ISP</div>
                <div className="text-sm font-semibold text-[#0b57d0] mt-1 truncate">
                  {telemetry.location}
                </div>
                <div className="text-[11px] text-[#747775] mt-0.5 truncate">
                  {telemetry.isp}
                </div>
              </div>

              <div className="p-3 bg-[#f8fafd] rounded-xl border border-[#e1e3e1] min-w-0">
                <div className="text-[10px] text-[#747775] uppercase truncate">왕복 지연시간 (RTT)</div>
                <div className="text-sm font-semibold text-[#188038] mt-1 truncate">{telemetry.rtt}</div>
                <div className="text-[11px] text-[#747775] mt-0.5 truncate">DTLS 암호화</div>
              </div>
            </div>

            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[10px] sm:text-[11px] font-mono text-[#747775] px-1">
                <span>TUNNEL TELEMETRY CONSOLE</span>
                <span>PACKET TRACKER</span>
              </div>
              <div className="bg-[#0f1117] text-[#a5d6a7] font-mono text-[10px] sm:text-[11px] p-3 sm:p-4 rounded-xl sm:rounded-2xl h-40 sm:h-48 overflow-y-auto border border-[#2d3139] shadow-inner space-y-1 w-full break-all">
                {logs.length === 0 ? (
                  <div className="text-[#5c6370]">콘솔 로그 대기 중...</div>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx} className="leading-relaxed whitespace-pre-wrap break-all">
                      <span className="text-[#61afef] select-none">$</span> {log}
                    </div>
                  ))
                )}
                <div ref={terminalEndRef} />
              </div>
            </div>
          </div>
        )}

        {/* 3. 파일 업로드 드롭존 */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            if (e.dataTransfer.files?.length) handleAddFiles(e.dataTransfer.files);
          }}
          className={`border-2 border-dashed rounded-2xl sm:rounded-3xl p-6 sm:p-8 text-center transition-all cursor-pointer ${
            isDragOver
              ? "border-[#0b57d0] bg-[#e8f0fe]"
              : "border-[#c4c7c5] hover:border-[#0b57d0] bg-white"
          }`}
        >
          <label className="cursor-pointer flex flex-col items-center">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-[#f1f3f4] text-[#0b57d0] flex items-center justify-center mb-2 sm:mb-3">
              <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <span className="text-xs sm:text-sm font-medium text-[#1f1f1f]">파일을 드래그하거나 탭하여 추가</span>
            <span className="text-[11px] sm:text-xs text-[#747775] mt-0.5">다중 파일 선택 가능 (순차 큐 다운로드 보장)</span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files?.length && handleAddFiles(e.target.files)}
            />
          </label>
        </div>

        {/* 4. 파일 목록 카드 */}
        {fileList.length > 0 && (
          <div className="bg-white rounded-2xl sm:rounded-3xl border border-[#e1e3e1] shadow-sm overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-[#e1e3e1] flex items-center justify-between bg-[#f8fafd] gap-2">
              <div className="text-xs font-medium text-[#444746] truncate">
                파일 {fileList.length}개 (선택 {selectedIds.length}개)
              </div>
              <div className="flex gap-1.5 sm:gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  disabled={selectedIds.length === 0}
                  className="px-2.5 sm:px-3 py-1.5 rounded-lg border border-[#c4c7c5] bg-white text-xs font-medium text-[#b3261e] hover:bg-[#fdf2f2] disabled:opacity-40 transition"
                >
                  선택 삭제
                </button>
                <button
                  type="button"
                  onClick={handleDeleteAll}
                  className="px-2.5 sm:px-3 py-1.5 rounded-lg border border-[#c4c7c5] bg-white text-xs font-medium text-[#444746] hover:bg-[#f1f3f4] transition"
                >
                  전체 삭제
                </button>
              </div>
            </div>

            <div className="divide-y divide-[#e1e3e1]">
              {fileList.map((item) => (
                <div key={item.id} className="p-3 sm:p-4 flex items-center justify-between gap-3 hover:bg-[#f8fafd] transition">
                  <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(item.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedIds((prev) => [...prev, item.id]);
                        } else {
                          setSelectedIds((prev) => prev.filter((id) => id !== item.id));
                        }
                      }}
                      className="w-4 h-4 rounded text-[#0b57d0] focus:ring-0 flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs sm:text-sm font-medium text-[#1f1f1f] truncate">
                        {item.file.name}
                      </div>
                      <div className="text-[11px] sm:text-xs text-[#747775]">
                        {(item.file.size / 1024 / 1024).toFixed(2)} MB
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setFileList((prev) => prev.filter((f) => f.id !== item.id));
                      setSelectedIds((prev) => prev.filter((id) => id !== item.id));
                      if (connRef.current?.open) {
                        setTimeout(() => broadcastManifest(connRef.current!), 100);
                      }
                    }}
                    className="text-xs text-[#747775] hover:text-[#b3261e] p-1.5 sm:p-2 transition flex-shrink-0"
                  >
                    삭제
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* 푸터: Notion 설명서 링크 연동 및 반응형 적용 */}
      <footer className="w-full border-t border-[#e1e3e1] bg-white py-6 sm:py-8 mt-8 sm:mt-12 text-[#444746] text-xs">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col items-center justify-center gap-2 sm:gap-2.5 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1">
            <span className="font-bold text-[#1f1f1f] text-xs sm:text-sm">Direct Drive</span>
            <span className="text-[#747775] text-[11px] sm:text-xs">P2P File Share Platform</span>
            <span className="text-[#c4c7c5] select-none">|</span>
            <span className="text-[11px] sm:text-xs">
              사이트 관련 문의 :{" "}
              <a href="mailto:devlee92736@gmail.com" className="text-[#0b57d0] hover:underline">
                devlee92736@gmail.com
              </a>
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[#747775] text-[10px] sm:text-[11px]">
            <a
              href="https://com-study.notion.site/Direct-Drive-3ee29cd9f9d88050b8f6fd3f437962f0?source=copy_link"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline hover:text-[#0b57d0] font-medium"
            >
              사용 설명서
            </a>
            <span className="text-[#c4c7c5] select-none">|</span>
            <a
              href="https://com-study.notion.site/Direct-Drive-3ee29cd9f9d8804ababac8c84c25ce13?source=copy_link"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline hover:text-[#1f1f1f]"
            >
              개인정보처리방침
            </a>
            <span className="text-[#c4c7c5] select-none">|</span>
            <a
              href="https://com-study.notion.site/Direct-Drive-3ee29cd9f9d880d6b413d01490a27e14?source=copy_link"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline hover:text-[#1f1f1f]"
            >
              서비스이용약관
            </a>
            <span className="text-[#c4c7c5] select-none">|</span>
            <span>© 2026 Direct Drive, Inc. All rights reserved powered by JH's SW Lab</span>
          </div>
        </div>
      </footer>
    </div>
  );
}