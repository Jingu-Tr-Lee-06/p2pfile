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

    // 버퍼 데드락 방지: 안전 대기 후 즉시 file_done 발송
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
    <div className="min-h-screen bg-[#f8fafd] text-[#1f1f1f] flex flex-col font-sans">
      <header className="h-16 border-b border-[#e1e3e1] bg-white px-6 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-[#e8f0fe] text-[#0b57d0]">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
            </svg>
          </div>
          <div>
            <span className="text-lg font-medium text-[#1f1f1f]">Direct Drive</span>
            <span className="ml-2 text-xs font-mono px-2 py-0.5 rounded-full bg-[#e8f0fe] text-[#0b57d0] font-medium">Console Engine</span>
          </div>
        </div>

        {shareUrl && (
          <div className="flex items-center gap-3">
            <div className="text-xs font-mono text-[#444746] bg-[#f1f3f4] px-3 py-1.5 rounded-full flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#188038]" />
              <span>만료까지: {Math.floor(timeLeft / 60)}분 {timeLeft % 60}초</span>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto p-6 sm:p-10 space-y-6">
        <div className="bg-white border border-[#e1e3e1] rounded-3xl p-6 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-[#1f1f1f]">공유 세션명 (접속 코드) 설정</div>
            <div className="text-xs text-[#747775] mt-0.5">상대방에게 전달할 맞춤형 코드를 직접 입력하세요.</div>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <span className="text-xs font-mono text-[#747775]">/receive#</span>
            <input
              type="text"
              value={customRoomId}
              onChange={(e) => setCustomRoomId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
              placeholder="세션 코드 입력"
              className="bg-[#f8fafd] border border-[#c4c7c5] rounded-xl px-3 py-2 text-xs font-mono w-36 text-center font-bold text-[#0b57d0] focus:outline-none focus:border-[#0b57d0]"
            />
            <button
              type="button"
              onClick={() => initSession(customRoomId)}
              className="px-4 py-2 bg-[#0b57d0] hover:bg-[#0842a0] text-white text-xs font-medium rounded-xl transition shadow-sm whitespace-nowrap active:scale-95"
            >
              {shareUrl ? "코드 변경" : "세션 열기"}
            </button>
          </div>
        </div>

        {shareUrl && (
          <div className="bg-white border border-[#e1e3e1] rounded-3xl p-6 shadow-sm space-y-5">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-[#e1e3e1]">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="w-2.5 h-2.5 rounded-full bg-[#188038] animate-pulse flex-shrink-0" />
                <span className="text-sm font-semibold text-[#1f1f1f] whitespace-nowrap flex-shrink-0">
                  터널 활성
                </span>
                <span className="text-xs text-[#747775] font-mono truncate max-w-[180px] sm:max-w-xs md:max-w-sm">
                  ({status})
                </span>
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#e8f0fe] text-[#0b57d0] font-bold whitespace-nowrap flex-shrink-0">
                  세션: {customRoomId}
                </span>
              </div>

              <div className="flex gap-2 w-full sm:w-auto flex-shrink-0">
                <input
                  readOnly
                  value={shareUrl}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="bg-[#f8fafd] border border-[#c4c7c5] rounded-xl px-3 py-2 text-xs font-mono flex-1 sm:w-72"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="px-4 py-2 bg-[#0b57d0] hover:bg-[#0842a0] text-white text-xs font-medium rounded-xl transition shadow-sm whitespace-nowrap active:scale-95"
                >
                  {copied ? "복사됨" : "링크 복사"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
              <div className="p-3 bg-[#f8fafd] rounded-xl border border-[#e1e3e1]">
                <div className="text-[10px] text-[#747775] uppercase">전송 속도 / 누적량</div>
                <div className="text-sm font-semibold text-[#1f1f1f] mt-1">{speed}</div>
                <div className="text-[11px] text-[#747775] mt-0.5">
                  총 {(telemetry.bytesSentTotal / 1024 / 1024).toFixed(2)} MB
                </div>
              </div>

              <div className="p-3 bg-[#f8fafd] rounded-xl border border-[#e1e3e1]">
                <div className="text-[10px] text-[#747775] uppercase">수신자 공인 IP</div>
                <div className="text-sm font-semibold text-[#1f1f1f] mt-1 truncate">
                  {telemetry.publicIp}
                </div>
                <div className="text-[11px] text-[#747775] mt-0.5 truncate">
                  타입: {telemetry.candidateType}
                </div>
              </div>

              <div className="p-3 bg-[#f8fafd] rounded-xl border border-[#e1e3e1]">
                <div className="text-[10px] text-[#747775] uppercase">수신자 위치 / ISP</div>
                <div className="text-sm font-semibold text-[#0b57d0] mt-1 truncate">
                  {telemetry.location}
                </div>
                <div className="text-[11px] text-[#747775] mt-0.5 truncate">
                  {telemetry.isp}
                </div>
              </div>

              <div className="p-3 bg-[#f8fafd] rounded-xl border border-[#e1e3e1]">
                <div className="text-[10px] text-[#747775] uppercase">왕복 지연시간 (RTT)</div>
                <div className="text-sm font-semibold text-[#188038] mt-1">{telemetry.rtt}</div>
                <div className="text-[11px] text-[#747775] mt-0.5">DTLS-SRTP 암호화</div>
              </div>
            </div>

            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[11px] font-mono text-[#747775] px-1">
                <span>TUNNEL TELEMETRY CONSOLE</span>
                <span>REALTIME PACKET TRACKER</span>
              </div>
              <div className="bg-[#0f1117] text-[#a5d6a7] font-mono text-[11px] p-4 rounded-2xl h-48 overflow-y-auto border border-[#2d3139] shadow-inner space-y-1">
                {logs.length === 0 ? (
                  <div className="text-[#5c6370]">콘솔 로그 대기 중...</div>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx} className="leading-relaxed">
                      <span className="text-[#61afef]">$</span> {log}
                    </div>
                  ))
                )}
                <div ref={terminalEndRef} />
              </div>
            </div>
          </div>
        )}

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
          className={`border-2 border-dashed rounded-3xl p-8 text-center transition-all cursor-pointer ${
            isDragOver
              ? "border-[#0b57d0] bg-[#e8f0fe]"
              : "border-[#c4c7c5] hover:border-[#0b57d0] bg-white"
          }`}
        >
          <label className="cursor-pointer flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-[#f1f3f4] text-[#0b57d0] flex items-center justify-center mb-3">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <span className="text-sm font-medium text-[#1f1f1f]">파일을 드래그하거나 클릭하여 추가</span>
            <span className="text-xs text-[#747775] mt-0.5">다중 파일 선택 가능 (순차 큐 다운로드 보장)</span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files?.length && handleAddFiles(e.target.files)}
            />
          </label>
        </div>

        {fileList.length > 0 && (
          <div className="bg-white rounded-3xl border border-[#e1e3e1] shadow-sm overflow-hidden">
            <div className="p-4 border-b border-[#e1e3e1] flex items-center justify-between bg-[#f8fafd]">
              <div className="text-xs font-medium text-[#444746]">
                총 {fileList.length}개 파일 (선택 {selectedIds.length}개)
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  disabled={selectedIds.length === 0}
                  className="px-3 py-1.5 rounded-lg border border-[#c4c7c5] bg-white text-xs font-medium text-[#b3261e] hover:bg-[#fdf2f2] disabled:opacity-40 transition"
                >
                  선택 삭제
                </button>
                <button
                  type="button"
                  onClick={handleDeleteAll}
                  className="px-3 py-1.5 rounded-lg border border-[#c4c7c5] bg-white text-xs font-medium text-[#444746] hover:bg-[#f1f3f4] transition"
                >
                  전체 삭제
                </button>
              </div>
            </div>

            <div className="divide-y divide-[#e1e3e1]">
              {fileList.map((item) => (
                <div key={item.id} className="p-4 flex items-center justify-between hover:bg-[#f8fafd] transition">
                  <div className="flex items-center gap-3 min-w-0">
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
                      className="w-4 h-4 rounded text-[#0b57d0] focus:ring-0"
                    />
                    <div className="truncate">
                      <div className="text-sm font-medium text-[#1f1f1f] truncate max-w-sm sm:max-w-md">
                        {item.file.name}
                      </div>
                      <div className="text-xs text-[#747775]">
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
                    className="text-xs text-[#747775] hover:text-[#b3261e] p-2 transition"
                  >
                    삭제
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
      {/* Footer */}
      <footer className="w-full border-t border-[#e1e3e1] bg-white py-8 mt-12 text-[#444746] text-xs">
        <div className="max-w-5xl mx-auto px-6 flex flex-col items-center justify-center gap-2.5">
          {/* 상단 라인: 브랜드명 | 슬로건 | 문의 이메일 */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center">
            <span className="font-bold text-[#1f1f1f] text-sm">Direct Drive</span>
            <span className="text-[#747775]">P2P File Share Platform</span>
            <span className="text-[#c4c7c5] select-none">|</span>
            <span>
              사이트 관련 문의 :{" "}
              <a
                href="mailto:devlee92736@gmail.com"
                className="text-[#0b57d0] hover:underline"
              >
                devlee92736@gmail.com
              </a>
            </span>
          </div>

          {/* 하단 라인: 노션 링크 연결 (새 탭으로 열기) | 카피라이트 */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[#747775] text-[11px] text-center">
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
            <span>
              © 2026 Direct Drive, Inc. All rights reserved powered by JH's SW Lab
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}