"use client";

import { createPublicClient, http } from "viem";
import { CHAIN } from "@/lib/env";
import { PRIVATE_RPC_URL } from "./config";

export const privatePublicClient = createPublicClient({ chain: CHAIN, transport: http(PRIVATE_RPC_URL) });
