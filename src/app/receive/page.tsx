"use client";

import { useEffect, useState, useRef } from "react";
import type Peer from "peerjs";
import type { DataConnection } from "peerjs";
import Link from "next/link";

interface RemoteFile {
  id: string;
  name: string;
  size: number;
  type: string;
}

interface TransferStatus {
  progress: number;
  done: boolean;
  blobUrl?: string;
}

export default function ReceiverPage() {
  const [targetRoomId, setTargetRoomId] = useState<string>("");
  const [activeRoomId, setActiveRoomId] = useState<string>("");
  const [fileList, setFileList] = useState<RemoteFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [transfers, setTransfers] = useState<{ [fileId: string]: TransferStatus }>({});
  const [status, setStatus] = useState<string>("대기 중");

  const connRef = useRef<DataConnection | null>(null);
  const activeBuffersRef = useRef<{ [fileId: string]: Blob[] }>({});
  const remoteFilesRef = useRef<RemoteFile[]>([]);

  remoteFilesRef.current = fileList;

  const fetchMyGeoIp = async () => {
    try {
      const res = await fetch("https://ipapi.co/json/");
      const data = await res.json();
      return {
        ip: data.ip,
        city: data.city,
        country: data.country_name,
        isp: data.org,
      };
    } catch {
      return {
        ip: "Unknown IP",
        city: "Unknown",
        country: "Unknown",
        isp: "Direct Peer",
      };
    }
  };

  const finalizeDownload = (fileId: string) => {
    const targetMeta = remoteFilesRef.current.find((f) => f.id === fileId);
    if (!targetMeta || !activeBuffersRef.current[fileId]) return;

    const fullBlob = new Blob(activeBuffersRef.current[fileId], {
      type: targetMeta.type || "application/octet-stream",
    });
    delete activeBuffersRef.current[fileId];

    const url = URL.createObjectURL(fullBlob);

    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = targetMeta.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.error("자동 다운로드 차단됨", e);
    }

    setTransfers((prev) => ({
      ...prev,
      [fileId]: { progress: 100, done: true, blobUrl: url },
    }));
  };

  const connectToSender = async (senderId: string) => {
    if (!senderId) return;
    setActiveRoomId(senderId);
    setStatus("송신자 연결 중...");

    const { default: Peer } = await import("peerjs");
    const peer = new Peer();

    peer.on("open", () => {
      const conn = peer.connect(senderId, { reliable: true });
      connRef.current = conn;

      conn.on("open", async () => {
        setStatus(`송신자 [${senderId}] 연결됨`);
        const geoData = await fetchMyGeoIp();
        conn.send({
          type: "client_telemetry",
          ...geoData,
        });
      });

      conn.on("data", (data: any) => {
        if (data.type === "manifest") {
          setFileList(data.files);
        } else if (data.type === "file_chunk") {
          const { fileId, data: chunkData, index, total } = data;
          if (!activeBuffersRef.current[fileId]) {
            activeBuffersRef.current[fileId] = [];
          }
          activeBuffersRef.current[fileId].push(new Blob([chunkData]));

          const isLastChunk = index + 1 === total;
          const currentProg = isLastChunk ? 100 : Math.min(99, Math.round(((index + 1) / total) * 100));

          setTransfers((prev) => ({
            ...prev,
            [fileId]: { progress: currentProg, done: isLastChunk ? true : false },
          }));

          if (isLastChunk) {
            finalizeDownload(fileId);
          }
        } else if (data.type === "file_done") {
          finalizeDownload(data.fileId);
        }
      });

      conn.on("close", () => {
        setStatus("세션 연결이 종료되었습니다.");
      });
    });

    peer.on("error", () => {
      setStatus("송신자를 찾을 수 없습니다. (코드 불일치 또는 종료됨)");
    });
  };

  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash) {
      setTargetRoomId(hash);
      connectToSender(hash);
    }
  }, []);

  const triggerDownload = (fileId: string) => {
    if (!connRef.current?.open) return;
    setTransfers((prev) => ({
      ...prev,
      [fileId]: { progress: 0, done: false },
    }));
    connRef.current.send({ type: "request_file", fileId });
  };

  const handleDownloadSelected = () => {
    selectedIds.forEach((fileId) => {
      if (!transfers[fileId]?.done) {
        triggerDownload(fileId);
      }
    });
  };

  const handleDownloadAll = () => {
    fileList.forEach((file) => {
      if (!transfers[file.id]?.done) {
        triggerDownload(file.id);
      }
    });
  };

  return (
    <div className="min-h-screen bg-[#f8fafd] text-[#1f1f1f] flex flex-col font-sans">
      {/* 헤더: Send / Receive 전환 토글 버튼 */}
      <header className="h-16 border-b border-[#e1e3e1] bg-white px-6 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-[#e8f0fe] text-[#0b57d0]">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
            </svg>
          </div>
          <div>
            <span className="text-lg font-medium text-[#1f1f1f]">Direct Drive</span>
            <span className="ml-2 text-xs font-mono px-2 py-0.5 rounded-full bg-[#e8f0fe] text-[#0b57d0] font-medium">Receive Mode</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center bg-[#f1f3f4] p-1 rounded-xl border border-[#e1e3e1]">
            <Link
              href="/"
              className="px-3 py-1 text-[#444746] hover:text-[#1f1f1f] text-xs font-medium rounded-lg transition"
            >
              Send
            </Link>
            <span className="px-3 py-1 bg-white text-[#0b57d0] text-xs font-semibold rounded-lg shadow-sm">
              Receive
            </span>
          </div>

          <div className="hidden sm:block text-xs text-[#747775]">{status}</div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto p-6 sm:p-10 space-y-6">
        <div className="bg-white rounded-3xl border border-[#e1e3e1] shadow-sm p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-[#1f1f1f]">공유 코드 수동 입력</div>
            <div className="text-xs text-[#747775] mt-0.5">상대방에게 전달받은 코드를 입력하여 방에 접속합니다.</div>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="text"
              value={targetRoomId}
              onChange={(e) => setTargetRoomId(e.target.value)}
              placeholder="예: 5BsXye"
              className="bg-[#f8fafd] border border-[#c4c7c5] rounded-xl px-3 py-2 text-xs font-mono w-40 text-center font-bold text-[#0b57d0] focus:outline-none focus:border-[#0b57d0]"
            />
            <button
              type="button"
              onClick={() => connectToSender(targetRoomId)}
              className="px-4 py-2 bg-[#0b57d0] hover:bg-[#0842a0] text-white text-xs font-medium rounded-xl transition shadow-sm whitespace-nowrap active:scale-95"
            >
              접속하기
            </button>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-[#e1e3e1] shadow-sm overflow-hidden">
          <div className="p-4 border-b border-[#e1e3e1] flex items-center justify-between bg-[#f8fafd]">
            <div className="text-xs font-medium text-[#444746]">
              공유 파일 목록 ({fileList.length}개)
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleDownloadSelected}
                disabled={selectedIds.length === 0}
                className="px-4 py-2 rounded-xl bg-[#0b57d0] text-white text-xs font-medium hover:bg-[#0842a0] disabled:opacity-40 transition shadow-sm"
              >
                선택 다운로드 ({selectedIds.length})
              </button>
              <button
                type="button"
                onClick={handleDownloadAll}
                disabled={fileList.length === 0}
                className="px-4 py-2 rounded-xl border border-[#c4c7c5] bg-white text-xs font-medium text-[#1f1f1f] hover:bg-[#f1f3f4] disabled:opacity-40 transition"
              >
                전체 다운로드
              </button>
            </div>
          </div>

          {fileList.length === 0 ? (
            <div className="p-12 text-center text-sm text-[#747775]">
              {activeRoomId ? "공유된 파일이 없거나 송신자가 목록을 비웠습니다." : "상단의 공유 코드를 입력하고 접속해 주세요."}
            </div>
          ) : (
            <div className="divide-y divide-[#e1e3e1]">
              {fileList.map((file) => {
                const transfer = transfers[file.id];
                return (
                  <div key={file.id} className="p-4 flex items-center justify-between hover:bg-[#f8fafd] transition">
                    <div className="flex items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(file.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedIds((prev) => [...prev, file.id]);
                          } else {
                            setSelectedIds((prev) => prev.filter((id) => id !== file.id));
                          }
                        }}
                        className="w-4 h-4 rounded text-[#0b57d0] focus:ring-0"
                      />
                      <div className="truncate">
                        <div className="text-sm font-medium text-[#1f1f1f] truncate max-w-xs sm:max-w-md">
                          {file.name}
                        </div>
                        <div className="text-xs text-[#747775]">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                          {transfer && !transfer.done && ` • ${transfer.progress}% 받는 중`}
                          {transfer?.done && ` • 다운로드 완료`}
                        </div>
                      </div>
                    </div>

                    <div>
                      {transfer?.done ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-[#188038] px-2.5 py-1 bg-[#e6f4ea] rounded-lg">
                            완료됨
                          </span>
                          {transfer.blobUrl && (
                            <a
                              href={transfer.blobUrl}
                              download={file.name}
                              className="text-xs text-[#0b57d0] hover:underline"
                            >
                              다시 저장
                            </a>
                          )}
                        </div>
                      ) : transfer && !transfer.done ? (
                        <div className="w-24 bg-[#e1e3e1] h-1.5 rounded-full overflow-hidden">
                          <div
                            className="bg-[#0b57d0] h-full transition-all duration-150"
                            style={{ width: `${transfer.progress}%` }}
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => triggerDownload(file.id)}
                          className="px-3.5 py-1.5 bg-[#f1f3f4] hover:bg-[#e8f0fe] hover:text-[#0b57d0] text-[#1f1f1f] text-xs font-medium rounded-lg transition"
                        >
                          다운로드
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
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