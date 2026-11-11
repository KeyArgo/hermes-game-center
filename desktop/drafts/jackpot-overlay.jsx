import React, { useState, useEffect, useRef, useCallback } from 'react';

const SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣'];
const REEL_COUNT = 3;
const SPIN_FRAMES = 12;
const FRAME_INTERVAL = 80;
const WIN_FADE_MS = 250;

function randomSymbol() {
  return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
}

export function SlotOverlay({ spin, balance, onPull, isPullAvailable, disableReason }) {
  const [reels, setReels] = useState([randomSymbol(), randomSymbol(), randomSymbol()]);
  const [isSpinning, setIsSpinning] = useState(false);
  const [showWin, setShowWin] = useState(false);
  const spinInterval = useRef(null);

  useEffect(() => {
    if (spin) {
      setReels([spin.reel1, spin.reel2, spin.reel3]);
      setShowWin(spin.payout > 0);
      setTimeout(() => setShowWin(false), WIN_FADE_MS);
    }
  }, [spin]);

  const handlePull = useCallback(() => {
    if (!isPullAvailable) return;
    setIsSpinning(true);
    let frame = 0;
    spinInterval.current = setInterval(() => {
      setReels([randomSymbol(), randomSymbol(), randomSymbol()]);
      frame++;
      if (frame >= SPIN_FRAMES) {
        clearInterval(spinInterval.current);
        setIsSpinning(false);
        onPull();
      }
    }, FRAME_INTERVAL);
  }, [isPullAvailable, onPull]);

  return (
    <div className="jackpot-tab">
      <div className="reels-container">
        {reels.map((symbol, i) => (
          <div key={i} className={`reel ${isSpinning ? 'spinning' : ''}`}>
            {symbol}
          </div>
        ))}
      </div>

      <div className="balance-display">
        💰 ${balance.toFixed(2)}
      </div>

      <button
        className="pull-button"
        onClick={handlePull}
        disabled={!isPullAvailable}
        title={disableReason}
      >
        {isPullAvailable ? '🎰 Pull' : disableReason}
      </button>

      {showWin && spin && (
        <div className="win-banner">
          <div className="win-message">{spin.message}</div>
          <div className="win-amount">+${spin.payout}</div>
        </div>
      )}

      <style jsx>{`
        .jackpot-tab {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          padding: 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 12px;
          color: white;
          font-family: sans-serif;
        }

        .reels-container {
          display: flex;
          gap: 10px;
          justify-content: center;
        }

        .reel {
          font-size: 48px;
          width: 70px;
          height: 70px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          border: 2px solid rgba(255, 255, 255, 0.4);
          transition: transform 0.1s;
        }

        .reel.spinning {
          animation: spin 0.1s infinite;
        }

        @keyframes spin {
          0%, 100% { transform: rotateY(0deg); }
          50% { transform: rotateY(180deg); }
        }

        .balance-display {
          font-size: 24px;
          font-weight: bold;
          background: rgba(0, 0, 0, 0.3);
          padding: 8px 16px;
          border-radius: 6px;
        }

        .pull-button {
          padding: 12px 24px;
          font-size: 16px;
          font-weight: bold;
          background: #ff6b6b;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .pull-button:hover:not(:disabled) {
          background: #ff5252;
          transform: scale(1.05);
        }

        .pull-button:disabled {
          background: #ccc;
          cursor: not-allowed;
          opacity: 0.6;
        }

        .win-banner {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: rgba(0, 0, 0, 0.9);
          padding: 24px;
          border-radius: 12px;
          text-align: center;
          animation: fadeInOut ${WIN_FADE_MS}ms ease-in-out;
          z-index: 9999;
        }

        .win-message {
          font-size: 20px;
          margin-bottom: 8px;
        }

        .win-amount {
          font-size: 32px;
          font-weight: bold;
          color: #4ade80;
        }

        @keyframes fadeInOut {
          0% { opacity: 0; }
          50% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
