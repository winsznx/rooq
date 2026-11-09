// Mirrors zk/circuits/lib/src/lib.nr. Change both together and bump RECORD_VERSION.
export const RECORD_VERSION = 1n;
export const TREE_DEPTH = 32;
export const AMOUNT_LIMIT = 1n << 100n;
export const FREE_DOMAIN = 0n;
export const APPEND_BATCH = 8;
export const NOTE_PT_LEN = 5;
export const NOTE_CT_LEN = NOTE_PT_LEN + 2;
export const LOCK_PT_LEN = 13;
export const LOCK_CT_LEN = LOCK_PT_LEN + 2;
export const PAIR_PT_LEN = 20;
export const PAIR_CT_LEN = PAIR_PT_LEN + 2;
export const PAIR_RECIPIENTS = 4;
export const MARKET_PT_LEN = 6;
export const CLAIM_PT_LEN = 11;
export const CLAIM_CT_LEN = CLAIM_PT_LEN + 2;
/** Order of a claim record's ciphertexts. */
export const CLAIM_CT_WINNER = 0;
export const CLAIM_CT_RISK_A = 1;
export const CLAIM_CT_RISK_B = 2;
export const MARKET_CT_LEN = MARKET_PT_LEN + 2;
/** Order of FundingAdvanced ciphertexts. */
export const MARKET_CT_COORDINATOR = 0;
export const MARKET_CT_RISK_A = 1;
export const MARKET_CT_RISK_B = 2;
export const OI_BATCH = 8;
/** close_pair modes. */
export const CLOSE_TAKER = 0n;
export const CLOSE_MATURED = 1n;
export const CLOSE_DEAD_ORACLE = 2n;
/** pair_update actors. */
export const ACTOR_NONE = 0n;
export const ACTOR_TAKER = 1n;
export const ACTOR_MAKER = 2n;
export const FUNDING_INDEX_ZERO = 1n << 128n;
/** Position of each recipient's ciphertext in a PAIR record. */
export const PAIR_CT_TAKER = 0;
export const PAIR_CT_MAKER = 1;
export const PAIR_CT_RISK_A = 2;
export const PAIR_CT_RISK_B = 3;

export const ROLE_TAKER = 1n;
export const ROLE_MAKER = 2n;
export const ROLE_SWAP = 3n;
export const ROLE_LP = 4n;
export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/** `kind` values of PrivatePairs.RecordCreated. */
export const RECORD_FREE = 1;
export const RECORD_LOCK = 2;
export const RECORD_PAIR = 3;
export const RECORD_CLAIM = 4;
export const RECORD_LP = 5;
export const POOL_PT_LEN = 5;
export const LP_PT_LEN = 10;
export const LP_CT_LEN = LP_PT_LEN + 2;
export const MINIMUM_LIQUIDITY = 1000n;

export const T_AUTH = 1n;
export const T_NK = 2n;
export const T_OWNER = 3n;
export const T_NOTE = 4n;
export const T_NF = 5n;
export const T_NODE = 7n;
export const T_ENC = 8n;
export const T_INNER = 15n;
export const T_RHO = 16n;
export const T_NF_REC = 6n;
export const T_LOCK = 9n;
export const T_PAIR = 10n;
export const T_TERMS = 11n;
export const T_NONCE = 12n;
export const T_MARKET = 13n;
export const T_OI = 14n;
export const T_CLAIM = 18n;
export const T_POOL = 19n;
export const T_LP = 20n;
/** Wallet-only: derivations from the backup seed. Never appears in a circuit. */
export const T_SEED = 17n;

export const KIND_DEPOSIT = 1n;
export const KIND_LEAF = 2n;
