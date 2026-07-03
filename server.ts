import { WebSocketServer, WebSocket } from "ws";
import {
  createGame,
  applyAction,
  viewFor,
  GameState,
  ActionType,
  loseCard,
    resolveChallenge,       // ⬅️ add
  resolveNoChallenge,
    resolveExchange,
    resolveBlock,
  resolveBlockUnchallenged,
  resolveAllow,
  CharacterCard,
  resolveBlockChallenge
} from "./gameLogic";

const PORT = Number(process.env.PORT) || 3000;
const wss = new WebSocketServer({ port: PORT });
console.log(`Coup server running on port ${PORT}`);

// ===== LOBBY + GAME STATE =====

type Seat = {
  socket: WebSocket;
  name: string;
  id: number;        // seat index / player id
};
let pendingBlockChallenge: { responders: number[] } | null = null;
let seats: Seat[] = [];
let game: GameState | null = null; // null while in lobby
let nextId = 0;
let pendingChallenge: { responders: number[] } | null = null;
let pendingBlock: { responders: number[] } | null = null;
// ===== BROADCAST HELPERS =====
// Networked games skip the pass-and-play "privacy" gate.
function normalizePhase() {
  if (game && game.phase === "privacy") {
    game.phase = "action";
  }
}
function setupBlockChallengeWindow() {
  if (!game || game.phase !== "awaitBlockChallenge" || !game.pendingAction) return;
  const blockerId = game.pendingAction.blockerId;
  pendingBlockChallenge = {
    responders: game.players
      .filter((p) => !p.eliminated && p.id !== blockerId)
      .map((p) => p.id),
  };
}
// When the game enters awaitBlock, figure out who can block.
function setupBlockWindow() {
  if (!game || game.phase !== "awaitBlock" || !game.pendingAction) return;
  const pa = game.pendingAction;

  if (pa.type === "foreignAid") {
    // anyone except the actor can block (claiming Duke)
    pendingBlock = {
      responders: game.players
        .filter((p) => !p.eliminated && p.id !== pa.actorId)
        .map((p) => p.id),
    };
  } else {
    // steal / assassinate: only the target can block
    pendingBlock = { responders: pa.targetId !== null ? [pa.targetId] : [] };
  }
}
// Call after any action/resolution to set up whatever response window we entered.
function setupResponseWindows() {
  setupChallengeWindow();
  setupBlockWindow();
  setupBlockChallengeWindow();
}
// After an action, if we entered awaitChallenge, set up who can respond.
function setupChallengeWindow() {
  if (game && game.phase === "awaitChallenge" && game.pendingAction) {
    const actorId = game.pendingAction.actorId;
    pendingChallenge = {
      responders: game.players
        .filter((p) => !p.eliminated && p.id !== actorId)
        .map((p) => p.id),
    };
  }
}
function broadcastLobby() {
  const playerList = seats.map((s) => ({ id: s.id, name: s.name }));
  for (const seat of seats) {
    if (seat.socket.readyState === WebSocket.OPEN) {
      seat.socket.send(
        JSON.stringify({
          type: "lobby",
          players: playerList,
          yourId: seat.id,
          isHost: seats.length > 0 && seats[0].id === seat.id, // first seat is host
        })
      );
    }
  }
}

function broadcastViews() {
  if (!game) return;
  for (const seat of seats) {
    if (seat.socket.readyState === WebSocket.OPEN) {
      seat.socket.send(
        JSON.stringify({ type: "view", view: viewFor(game, seat.id) })
      );
    }
  }
}

// ===== CONNECTIONS =====

wss.on("connection", (socket) => {
  console.log("A socket connected.");

  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // --- JOIN: claim a seat with a name ---
      if (msg.type === "join") {
        // ignore joins once the game has started
        if (game) return;
        const seat: Seat = { socket, name: msg.name || `Player ${nextId + 1}`, id: nextId };
        nextId++;
        seats.push(seat);
        console.log(`${seat.name} joined as seat ${seat.id}.`);
        broadcastLobby();
      }
      else if (msg.type === "exchange") {
        if (!game) return;
        const seat = seats.find((s) => s.socket === socket);
        if (!seat) return;
        if (game.phase !== "exchange" || game.currentPlayerIndex !== seat.id) return;
        resolveExchange(game, msg.keepIndices);
        setupResponseWindows();
        normalizePhase();
        broadcastViews();
      }
      else if (msg.type === "restart") {
        const seat = seats.find((s) => s.socket === socket);
        if (!seat) return;
        // only the host (first seat) can restart
        if (seats[0]?.id !== seat.id) return;
        game = null;                    // back to lobby
        pendingChallenge = null;        // clear any leftover windows
        pendingBlock = null;
        pendingBlockChallenge = null;
        broadcastLobby();               // everyone returns to the lobby
      }
      

else if (msg.type === "start") {
        const host = seats[0];
        if (!host || host.socket !== socket) return;
        if (seats.length < 2) return;

        game = createGame(seats.map((s) => s.name));
        game.phase = "action";   // ⬅️ skip the privacy gate — not needed online
        console.log("Game started.");
         normalizePhase(); 
        broadcastViews();
      }
      // --- LOSE CARD: a player picks which influence to lose ---
      else if (msg.type === "loseCard") {
        if (!game) return;
        const seat = seats.find((s) => s.socket === socket);
        if (!seat) return;
        // only the player who must lose can do so
        if (game.pendingLoss !== seat.id) return;
        loseCard(game, seat.id, msg.cardIndex);
         setupResponseWindows();
        normalizePhase(); 
        console.log("After action — phase:", game.phase, "currentPlayer:", game.currentPlayerIndex);

        broadcastViews();
      }
      else if (msg.type === "respondBlockChallenge") {
        if (!game || !pendingBlockChallenge) return;
        const seat = seats.find((s) => s.socket === socket);
        if (!seat) return;
        if (!pendingBlockChallenge.responders.includes(seat.id)) return;

        if (msg.decision === "challenge") {
          // first challenge of the block wins
          pendingBlockChallenge = null;
          resolveBlockChallenge(game, seat.id);
          setupResponseWindows();   // resolution may enter loseInfluence/resume — handle any new window
          normalizePhase();
          broadcastViews();
        } else {
          // allow → remove from responders
          pendingBlockChallenge.responders = pendingBlockChallenge.responders.filter(
            (id) => id !== seat.id
          );
          if (pendingBlockChallenge.responders.length === 0) {
            // no one challenged the block → block stands
            pendingBlockChallenge = null;
            resolveBlockUnchallenged(game);
            normalizePhase();
            broadcastViews();
          } else {
            broadcastViews();
          }
        }
      }
      else if (msg.type === "respondChallenge") {
        if (!game || !pendingChallenge) return;
        const seat = seats.find((s) => s.socket === socket);
        if (!seat) return;
        // must be someone we're actually waiting on
        if (!pendingChallenge.responders.includes(seat.id)) return;

        if (msg.decision === "challenge") {
          // first challenge wins — resolve it, clear the window
          pendingChallenge = null;
          resolveChallenge(game, seat.id);
          setupResponseWindows();
          normalizePhase();
          broadcastViews();
        } else {
          // allow → remove them from the responders list
          pendingChallenge.responders = pendingChallenge.responders.filter(
            (id) => id !== seat.id
          );
          if (pendingChallenge.responders.length === 0) {
            // everyone allowed → action proceeds
            pendingChallenge = null;
            resolveNoChallenge(game);
            setupResponseWindows();
            normalizePhase();
            broadcastViews();
          } else {
            // still waiting on others
            broadcastViews();
          }
        }
      }
      else if (msg.type === "respondBlock") {
        if (!game || !pendingBlock) return;
        const seat = seats.find((s) => s.socket === socket);
        if (!seat) return;
        if (!pendingBlock.responders.includes(seat.id)) return;

        if (msg.decision === "block") {
          const blockClaim = msg.blockClaim as CharacterCard;
          pendingBlock = null;
          resolveBlock(game, seat.id, blockClaim); // sets phase → awaitBlockChallenge, records blocker
          setupResponseWindows();
          normalizePhase();
          broadcastViews();
        }else {
          // allow → remove from responders
          pendingBlock.responders = pendingBlock.responders.filter((id) => id !== seat.id);
          if (pendingBlock.responders.length === 0) {
            // no one blocked → the action proceeds
            pendingBlock = null;
            resolveAllow(game);   // your existing "action goes through" resolver
            setupResponseWindows();
            normalizePhase();
            broadcastViews();
          } else {
            broadcastViews();
          }
        }
      }
      // --- ACTION: in-game move ---
else if (msg.type === "action") {
        if (!game) return;
        const seat = seats.find((s) => s.socket === socket);
        if (!seat) return;
        if (game.currentPlayerIndex !== seat.id) return;
        applyAction(game, msg.action as ActionType, msg.targetId ?? null);
        setupResponseWindows();   // ⬅️ NEW — set up responders if we're awaiting a challenge
        normalizePhase();
        broadcastViews();
      }
    } catch (err) {
      console.error("Bad message:", err);
    }
    
  });
  
  socket.on("close", () => {
    const seat = seats.find((s) => s.socket === socket);
    if (seat) console.log(`${seat.name} disconnected.`);
    // For now, remove from lobby if game hasn't started.
    if (!game) {
      seats = seats.filter((s) => s.socket !== socket);
      broadcastLobby();
    }
    // (Mid-game disconnects we'll handle properly later.)
  });
});