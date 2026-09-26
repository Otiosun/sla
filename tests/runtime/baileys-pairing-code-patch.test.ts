import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const baileysRoot = resolve(process.cwd(), "node_modules/@whiskeysockets/baileys/lib");

async function source(relativePath: string): Promise<string> {
  return readFile(resolve(baileysRoot, relativePath), "utf8");
}

describe("Baileys rc14 pairing-code patch", () => {
  it("keeps companion_hello behind pair-device readiness and waits for query success", async () => {
    const socket = await source("Socket/socket.js");
    const sendRequestStart = socket.indexOf("const sendPairingCodeRequest = async");
    const requestStart = socket.indexOf("const requestPairingCode = async");
    const waitForPairDevice = socket.indexOf("if (!pairingReady)", requestStart);
    const sendRequest = socket.indexOf("return await sendPairingCodeRequest", requestStart);
    const pairDevice = socket.indexOf("ws.on('CB:iq,type:set,pair-device'");
    const releaseRequest = socket.indexOf("pairingReady = true", pairDevice);
    const query = socket.indexOf("const result = await query", sendRequestStart);
    const persistIdentity = socket.indexOf(
      "authState.creds.me = { id: jid, name: '~' }",
      sendRequestStart,
    );

    expect(sendRequestStart).toBeGreaterThan(-1);
    expect(requestStart).toBeGreaterThan(-1);
    expect(waitForPairDevice).toBeGreaterThan(requestStart);
    expect(sendRequest).toBeGreaterThan(waitForPairDevice);
    expect(pairDevice).toBeGreaterThan(-1);
    expect(releaseRequest).toBeGreaterThan(pairDevice);
    expect(query).toBeGreaterThan(-1);
    expect(persistIdentity).toBeGreaterThan(query);
  });

  it("retains the malformed companion-registration guard", async () => {
    const messagesRecv = await source("Socket/messages-recv.js");
    const guard = messagesRecv.indexOf("notification without pairing data, skipping");
    const requiredIdentity = messagesRecv.indexOf(
      "toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'))",
    );

    expect(guard).toBeGreaterThan(-1);
    expect(requiredIdentity).toBeGreaterThan(guard);
  });
});
