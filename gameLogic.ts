// ===== TYPES =====

export type CharacterCard = "Duke" | "Assassin" | "Captain" | "Ambassador" | "Contessa";

export type Player = {
  id: number;
  name: string;
  cards: CharacterCard[];      // face-down influence still held
  lostCards: CharacterCard[];  // revealed/lost influence
  coins: number;
  eliminated: boolean;
  lastMove: string;
};

// What screen the game is currently showing
export type Phase =
  | "privacy" | "action" | "loseInfluence" | "awaitBlock"
  | "exchange" | "awaitChallenge" | "awaitBlockChallenge" | "gameOver";

export type GameState = {
  players: Player[];
  deck: CharacterCard[];
  currentPlayerIndex: number;
  phase: Phase;
  exchangeCards: CharacterCard[] | null;  // temp pile during an Ambassador exchange
  pendingLoss: number | null;
  returnPhase: Phase | "resumeAction" | "resumeBlockedAction";
pendingAction: {
    type: "steal" | "assassinate" | "foreignAid" | "tax" | "exchange";
    actorId: number;
    targetId: number | null;
    blockerId: number | null;
    claimedCharacter: CharacterCard | null;       // actor's claim
    blockClaimedCharacter: CharacterCard | null;  // blocker's claim (Step B)
  } | null;
  log: string[];
};

// ===== DECK =====

const CHARACTERS: CharacterCard[] = [
  "Duke",
  "Assassin",
  "Captain",
  "Ambassador",
  "Contessa",
];

function buildDeck(): CharacterCard[] {
  const deck: CharacterCard[] = [];
  for (const c of CHARACTERS) {
    deck.push(c, c, c); // 3 of each = 15 cards
  }
  return shuffle(deck);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===== SETUP =====

export function createGame(playerNames: string[]): GameState {
  const deck = buildDeck();
  const players: Player[] = playerNames.map((name, i) => ({
    id: i,
    name,
    exchangeCards: null,
    cards: [deck.pop()!, deck.pop()!], // deal 2 each
    lostCards: [],
    coins: 2,
    eliminated: false,
    lastMove: "—",
  }));

  return {
    players,
    deck,
    exchangeCards: null,
    currentPlayerIndex: 0,
    phase: "privacy",
    pendingLoss: null,
    returnPhase: "action",
    pendingAction: null,
    log: [`Game started with ${players.length} players.`],
  };
}

// ===== HELPERS =====

// Which character does each action claim? (null = no claim, can't be challenged)
function claimedCharacterFor(action: ActionType): CharacterCard | null {
  switch (action) {
    case "tax": return "Duke";
    case "steal": return "Captain";
    case "assassinate": return "Assassin";
    case "exchange": return "Ambassador";
    default: return null; // income, foreignAid, coup claim nothing
  }
}
export function currentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex];
}

// living opponents of the current player (valid targets)
export function targetsFor(state: GameState): Player[] {
  return state.players.filter(
    (p) => !p.eliminated && p.id !== currentPlayer(state).id
  );
}

function advanceTurn(state: GameState): void {
  // move to the next non-eliminated player
  let next = state.currentPlayerIndex;
  do {
    next = (next + 1) % state.players.length;
  } while (state.players[next].eliminated);
  state.currentPlayerIndex = next;
  state.phase = "privacy";
}

function checkWin(state: GameState): boolean {
  const alive = state.players.filter((p) => !p.eliminated);
  if (alive.length === 1) {
    state.phase = "gameOver";
    state.log.push(`${alive[0].name} wins!`);
    return true;
  }
  return false;
}
// ===== ACTIONS =====

export type ActionType =
  | "income"
  | "foreignAid"
  | "tax"
  | "steal"
  | "coup"
  | "assassinate"
  | "exchange";

// Does this action need a target?
export function actionNeedsTarget(action: ActionType): boolean {
  return action === "steal" || action === "coup" || action === "assassinate";
}

// Make a player lose an influence: switch to the lose-influence screen for them
function triggerLoss(
  state: GameState,
  playerId: number,
  afterLoss: GameState["returnPhase"] = "privacy"
): void {
  const player = state.players.find((p) => p.id === playerId)!;
  state.returnPhase = afterLoss;            // set BEFORE losing, so loseCard reads the right value
  if (player.cards.length === 1) {
    loseCard(state, playerId, 0);
  } else {
    state.pendingLoss = playerId;
    state.phase = "loseInfluence";
  }
}

// Actually remove a specific card (by index) from a player's hand
export function loseCard(state: GameState, playerId: number, cardIndex: number): void {
  const player = state.players.find((p) => p.id === playerId)!;
  const [lost] = player.cards.splice(cardIndex, 1);
  player.lostCards.push(lost);
  state.log.push(`${player.name} lost a ${lost}.`);

  if (player.cards.length === 0) {
    player.eliminated = true;
    state.log.push(`${player.name} is out of the game.`);
  }

  state.pendingLoss = null;

  // if losing that card ended the game, stop here
  if (checkWin(state)) return;

  if (state.returnPhase === "resumeAction") {
    performPendingEffect(state);
  } else if (state.returnPhase === "resumeBlockedAction") {
    performBlockedAction(state);
  } else if (state.returnPhase === "privacy") {
    advanceTurn(state);
  } else {
    state.phase = state.returnPhase;
  }
}
// Carry out the actual effect of the pending action (called after challenge resolves).
function performPendingEffect(state: GameState): void {
  const pa = state.pendingAction!;
  const actor = state.players.find((p) => p.id === pa.actorId)!;

  switch (pa.type) {
    case "tax":
      actor.coins += 3;
      state.log.push(`${actor.name} collected Tax (+3).`);
      state.pendingAction = null;
      advanceTurn(state);
      break;

    case "steal": {
      // steal can still be blocked → go to the block step instead of resolving
      state.phase = "awaitBlock";
      break;
    }

    case "assassinate": {
      // assassinate can still be blocked (Contessa) → go to block step
      state.phase = "awaitBlock";
      break;
    }

    case "exchange": {
      // exchange: now draw the 2 cards and go to the selection screen
      const drawn = [state.deck.pop()!, state.deck.pop()!];
      state.exchangeCards = [...actor.cards, ...drawn];
      state.phase = "exchange";
      break;
    }

    default:
      state.pendingAction = null;
      advanceTurn(state);
  }
}
// The main entry point: perform an action for the current player.
// targetId is required for steal / coup / assassinate.
export function applyAction(
  state: GameState,
  action: ActionType,
  targetId: number | null
): void {
  const me = currentPlayer(state);

  switch (action) {
    case "income":
      me.coins += 1;
      state.log.push(`${me.name} took Income (+1).`);
      advanceTurn(state);
      me.lastMove = "Income";
      break;

case "exchange": {
      state.pendingAction = {
        blockClaimedCharacter: null,
        type: "exchange",
        actorId: me.id,
        targetId: null,
        blockerId: null,
        
        claimedCharacter: "Ambassador",
      };
      me.lastMove = "exchange(2 cards)",
      state.phase = "awaitChallenge";
      state.log.push(`${me.name} claims Ambassador to exchange.`);
      break;
    }
case "foreignAid":
      state.pendingAction = {
        blockClaimedCharacter: null,
        type: "foreignAid",
        actorId: me.id,
        targetId: null,
        blockerId: null,
        claimedCharacter: null
      };
      me.lastMove = "foreignAid(2 coins)",
      state.phase = "awaitBlock";
      state.log.push(`${me.name} attempts Foreign Aid (+2).`);
      break;

    case "tax": {
      state.pendingAction = {
        blockClaimedCharacter: null,
        type: "tax",
        actorId: me.id,
        targetId: null,
        blockerId: null,
        claimedCharacter: "Duke",
      };
      me.lastMove = "Duke(3 coins)",
      state.phase = "awaitChallenge";
      state.log.push(`${me.name} claims Duke to Tax (+3).`);
      break;
    }
case "steal": {
      const target = state.players.find((p) => p.id === targetId)!;
      state.pendingAction = {
        blockClaimedCharacter: null,
        type: "steal",
        actorId: me.id,
        targetId: target.id,
        blockerId: null,
        claimedCharacter: "Captain",
      };
      me.lastMove = "Steal(cap)",
      state.phase = "awaitChallenge";
      state.log.push(`${me.name} claims Captain to steal from ${target.name}.`);
      break;
    }

    case "coup": {
      me.coins -= 7;
      const target = state.players.find((p) => p.id === targetId)!;
      state.log.push(`${me.name} launched a Coup on ${target.name}.`);
      me.lastMove = "Coup",
      triggerLoss(state, target.id);
      
      break;
    }

    case "assassinate": {
      me.coins -= 3;
      const target = state.players.find((p) => p.id === targetId)!;
      state.pendingAction = {
        blockClaimedCharacter: null,
        type: "assassinate",
        actorId: me.id,
        targetId: target.id,
        blockerId: null,
        claimedCharacter: "Assassin",
      };
      me.lastMove = "Assasinate",
      state.phase = "awaitChallenge";
      state.log.push(`${me.name} claims Assassin to assassinate ${target.name}.`);
      break;
    }
  }
}

// Which actions can the current player legally take right now?
export function legalActions(state: GameState): ActionType[] {
  const me = currentPlayer(state);

  // Rule: with 10+ coins you MUST coup
  if (me.coins >= 10) {
    return ["coup"];
  }

const actions: ActionType[] = ["income", "foreignAid", "tax", "exchange"];
  actions.push("steal");
  if (me.coins >= 3) actions.push("assassinate");
  if (me.coins >= 7) actions.push("coup");

  return actions;
}
// ===== STEAL RESOLUTION =====

// ===== BLOCKABLE ACTION RESOLUTION =====

// Target allows the action: it goes through.
// ===== BLOCKABLE ACTION RESOLUTION =====

// No one blocks: the action goes through.
export function resolveAllow(state: GameState): void {
  const pa = state.pendingAction!;
  const actor = state.players.find((p) => p.id === pa.actorId)!;

  if (pa.type === "steal") {
    const target = state.players.find((p) => p.id === pa.targetId)!;
    const amount = Math.min(2, target.coins);
    target.coins -= amount;
    actor.coins += amount;
    state.log.push(`${actor.name} stole ${amount} from ${target.name}.`);
    state.pendingAction = null;
    advanceTurn(state);
  } else if (pa.type === "foreignAid") {
    actor.coins += 2;
    state.log.push(`${actor.name} took Foreign Aid (+2).`);
    state.pendingAction = null;
    advanceTurn(state);
  } else {
    // assassinate allowed → target loses an influence
    const target = state.players.find((p) => p.id === pa.targetId)!;
    state.log.push(`Assassination on ${target.name} succeeds.`);
    state.pendingAction = null;
    triggerLoss(state, target.id);
  }
}

// A player blocks the action by claiming the relevant character.
// A player declares a block. This now opens a window for others to challenge the block.
export function resolveBlock(state: GameState, blockerId: number, blockClaim: CharacterCard): void {
  const pa = state.pendingAction!;
  const blocker = state.players.find((p) => p.id === blockerId)!;
  pa.blockerId = blockerId;
  pa.blockClaimedCharacter = blockClaim;

  state.log.push(`${blocker.name} blocks, claiming ${blockClaim}.`);
  state.phase = "awaitBlockChallenge";
}
// No one challenges the block → the block stands, original action is cancelled.
export function resolveBlockUnchallenged(state: GameState): void {
  const pa = state.pendingAction!;
  const blocker = state.players.find((p) => p.id === pa.blockerId!)!;
  state.log.push(`${blocker.name}'s block stands. Action stopped.`);
  state.pendingAction = null;
  advanceTurn(state);
}
// STEP 2 will implement this fully.
// A player challenges the block. (Step 2 — full resolution.)
export function resolveBlockChallenge(state: GameState, challengerId: number): void {
  const pa = state.pendingAction!;
  const blocker = state.players.find((p) => p.id === pa.blockerId!)!;
  const challenger = state.players.find((p) => p.id === challengerId)!;
  const claim = pa.blockClaimedCharacter!;

  const blockerHasIt = blocker.cards.includes(claim);

  if (blockerHasIt) {
    // Block was legit → challenge FAILS. Block stands, action stays stopped.
    state.log.push(`${blocker.name} reveals ${claim}! Block holds. ${challenger.name}'s challenge fails.`);
    redrawCard(state, blocker.id, claim);

    // challenger loses a card; afterwards the block stands → just move on.
    state.returnPhase = "privacy";
    triggerLoss(state, challenger.id);
  } else {
    // Block was a bluff → challenge SUCCEEDS. Blocker loses a card, AND the original action proceeds.
    state.log.push(`${blocker.name} did not have ${claim}! Block fails.`);

    // blocker loses a card; afterwards, resume the ORIGINAL action.
    state.returnPhase = "resumeBlockedAction";
    triggerLoss(state, blocker.id);
  }
}
// ===== EXCHANGE RESOLUTION =====

// ===== EXCHANGE RESOLUTION =====

// keepIndices: positions in state.exchangeCards the player chose to keep.
export function resolveExchange(state: GameState, keepIndices: number[]): void {
  const me = currentPlayer(state);
  const pile = state.exchangeCards!;

  // the kept cards become the player's new hand
  const kept: CharacterCard[] = keepIndices.map((i) => pile[i]);

  // everything not kept goes back to the deck
  const returned: CharacterCard[] = pile.filter((_, i) => !keepIndices.includes(i));

  me.cards = kept;
  state.deck.push(...returned);
  state.deck = shuffle(state.deck);

  state.exchangeCards = null;
  state.log.push(`${me.name} finished exchanging.`);
  advanceTurn(state);
}
// ===== CHALLENGE RESOLUTION (Stage A: actions) =====

// No one challenges → the action simply happens.
export function resolveNoChallenge(state: GameState): void {
  performPendingEffect(state);
}

// A player challenges the actor's claim.
export function resolveChallenge(state: GameState, challengerId: number): void {
  const pa = state.pendingAction!;
  const actor = state.players.find((p) => p.id === pa.actorId)!;
  const challenger = state.players.find((p) => p.id === challengerId)!;
  const claimed = pa.claimedCharacter!;

  const actorHasIt = actor.cards.includes(claimed);

  if (actorHasIt) {
    state.log.push(`${actor.name} reveals ${claimed}! ${challenger.name}'s challenge fails.`);
    redrawCard(state, actor.id, claimed);
    // challenger loses an influence; AFTER that, the action proceeds
    triggerLoss(state, challenger.id, "resumeAction");   // ⬅️ pass it in
  } else {
    state.log.push(`${actor.name} did not have ${claimed}! Bluff caught.`);
    state.pendingAction = null;
    triggerLoss(state, actor.id, "privacy");             // ⬅️ explicit
  }
}

// Return a specific card to the deck, shuffle, and draw a replacement.
function redrawCard(state: GameState, playerId: number, character: CharacterCard): void {
  const player = state.players.find((p) => p.id === playerId)!;
  const idx = player.cards.indexOf(character);
  if (idx === -1) return;
  // remove the proven card, put it back in the deck
  const [card] = player.cards.splice(idx, 1);
  state.deck.push(card);
  state.deck = shuffle(state.deck);
  // draw a fresh one
  player.cards.push(state.deck.pop()!);
}
// The block was a bluff and got caught → carry out the original action now.
function performBlockedAction(state: GameState): void {
  const pa = state.pendingAction!;
  const actor = state.players.find((p) => p.id === pa.actorId)!;

  switch (pa.type) {
    case "foreignAid":
      actor.coins += 2;
      state.log.push(`Block failed — ${actor.name} takes Foreign Aid (+2).`);
      state.pendingAction = null;
      advanceTurn(state);
      break;

    case "steal": {
      const target = state.players.find((p) => p.id === pa.targetId)!;
      const amount = Math.min(2, target.coins);
      target.coins -= amount;
      actor.coins += amount;
      state.log.push(`Block failed — ${actor.name} steals ${amount} from ${target.name}.`);
      state.pendingAction = null;
      advanceTurn(state);
      break;
    }

    case "assassinate": {
      const target = state.players.find((p) => p.id === pa.targetId)!;
      state.log.push(`Block failed — assassination on ${target.name} proceeds.`);
      state.pendingAction = null;
      triggerLoss(state, target.id); // target loses an influence (may be their 2nd loss)
      break;
    }

    default:
      state.pendingAction = null;
      advanceTurn(state);
  }
}
// ===== PER-PLAYER VIEW FILTERING =====

// A version of a player as seen by OTHERS (hidden cards become just a count)
export type PublicPlayer = {
  id: number;
  name: string;
  cardCount: number;       // how many influence they hold (not which)
  lostCards: CharacterCard[]; // revealed cards are public
  coins: number;
  eliminated: boolean;
  lastMove: string;
};

// What a single player is allowed to see of the whole game
export type PlayerView = {
  you: Player;                 // your own full player (you can see your cards)
  players: PublicPlayer[];     // everyone, with hidden cards reduced to counts
  currentPlayerIndex: number;
  phase: Phase;
  pendingLoss: number | null;
  pendingAction: GameState["pendingAction"];
  exchangeCards: CharacterCard[] | null; // only meaningful for the acting player; see note
  log: string[];
  yourId: number;
};

// Build the view for one player
export function viewFor(state: GameState, playerId: number): PlayerView {
  const you = state.players.find((p) => p.id === playerId)!;

  const players: PublicPlayer[] = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    cardCount: p.cards.length,
    lostCards: p.lostCards,
    coins: p.coins,
    eliminated: p.eliminated,
    lastMove: p.lastMove,
  }));

  return {
    you,
    players,
    currentPlayerIndex: state.currentPlayerIndex,
    phase: state.phase,
    pendingLoss: state.pendingLoss,
    pendingAction: state.pendingAction,
    // only send exchange cards to the player doing the exchange; others get null
    exchangeCards:
      state.phase === "exchange" && state.currentPlayerIndex === playerId
        ? state.exchangeCards
        : null,
    log: state.log,
    yourId: playerId,
  };
}