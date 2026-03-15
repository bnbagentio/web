import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import FormData from "form-data";
import axios from "axios";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: path.join(__dirname, "tmp") });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const RPC = process.env.RPC || "https://bsc-dataseed.binance.org/";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const FLAP_PORTAL = process.env.FLAP_PORTAL || "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const FLAP_VAULT_PORTAL = process.env.FLAP_VAULT_PORTAL || "0x90497450f2a706f1951b5bdda52B4E5d16f34C06";
const FLAP_UPLOAD_API = process.env.FLAP_UPLOAD_API || "https://funcs.flap.sh/api/upload";
const BNBSHARE_BASE = process.env.BNBSHARE_BASE || "https://bnbshare.fun/api/v2";
const DB_FILE = path.join(__dirname, "database.json");

// official registered vaults on BNB mainnet
const SPLIT_VAULT_FACTORY = process.env.SPLIT_VAULT_FACTORY || "0xfab75Dc774cB9B38b91749B8833360B46a52345F";
const GIFT_VAULT_FACTORY = process.env.GIFT_VAULT_FACTORY || "0x025549F52B03cF36f9e1a337c02d3AA7Af66ab32";

const provider = new ethers.JsonRpcProvider(RPC);

function readDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return []; } }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function addRecent(entry) {
  const db = readDB();
  db.unshift({ id: ethers.hexlify(ethers.randomBytes(8)), createdAt: Date.now(), ...entry });
  writeDB(db);
}

async function uploadMeta({ imagePath, description, website, twitter, telegram }) {
  const form = new FormData();
  const operations = {
    query: `mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }`,
    variables: { file: null, meta: { website: website || null, twitter: twitter || null, telegram: telegram || null, description: description || "", creator: "0x0000000000000000000000000000000000000000" } }
  };
  form.append("operations", JSON.stringify(operations));
  form.append("map", JSON.stringify({ "0": ["variables.file"] }));
  form.append("0", fs.createReadStream(imagePath));
  const res = await axios.post(FLAP_UPLOAD_API, form, { headers: form.getHeaders() });
  const cid = res?.data?.data?.create;
  if (!cid) throw new Error("metadata upload failed");
  return cid;
}

function buildPortalContract(wallet) {
  const abi = [
    "function newTokenV5((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint16 taxRate,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint24 lpFeeProfile,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance)) payable returns (address)"
  ];
  return new ethers.Contract(FLAP_PORTAL, abi, wallet);
}

function buildVaultPortalContract(wallet) {
  const abi = [
    "function newTaxTokenWithVault((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint16 taxRate,uint8 migratorType,address quoteToken,uint256 quoteAmt,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint24 lpFeeProfile,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address vaultFactory,bytes vaultData)) payable returns (address)"
  ];
  return new ethers.Contract(FLAP_VAULT_PORTAL, abi, wallet);
}

function randomSalt() { return ethers.hexlify(ethers.randomBytes(32)); }

function normalize(body) {
  return {
    source: body.source || "flap",
    caStore: body.caStore || "none",
    name: String(body.name || ""),
    symbol: String(body.symbol || ""),
    description: String(body.description || ""),
    website: body.website || "",
    twitter: body.twitter || "",
    telegram: body.telegram || "",
    supply: String(body.supply || "1000000000"),
    devBuy: String(body.devBuy || "0"),
    taxRate: Number(body.taxRate || 0),
    taxDuration: Number(body.taxDuration || 0),
    antiFarmerDuration: Number(body.antiFarmerDuration || 0),
    mktBps: Number(body.mktBps || 10000),
    deflationBps: Number(body.deflationBps || 0),
    dividendBps: Number(body.dividendBps || 0),
    lpBps: Number(body.lpBps || 0),
    minimumShareBalance: String(body.minimumShareBalance || "0"),
    beneficiary: body.beneficiary || "",
    dexThresh: Number(body.dexThresh || 0),
    dexId: Number(body.dexId || 0),
    lpFeeProfile: Number(body.lpFeeProfile || 3000),
    quoteToken: body.quoteToken || ethers.ZeroAddress,
    feeRecipientAddress: body.feeRecipientAddress || "",
    feeRecipientXUsername: body.feeRecipientXUsername || "",
    feeRecipientTelegramUsername: body.feeRecipientTelegramUsername || "",
    vaultFactory: body.vaultFactory || ethers.ZeroAddress,
    vaultData: body.vaultData || "0x",
    splitRecipients: body.splitRecipients || "[]",
    xHandle: (body.xHandle || "").trim().toLowerCase()
  };
}

function recentEntry(body, txHash, tokenAddress) {
  return {
    source: body.source || "flap",
    status: "new",
    progress: Number(body.devBuy || 0) > 0 ? 5 : 0,
    name: body.name,
    symbol: body.symbol,
    txHash,
    tokenAddress,
    taxRate: body.taxRate,
    caStore: body.caStore,
    chartUrl: tokenAddress ? `https://bnb.flap.sh/token/${tokenAddress}` : "https://bnb.flap.sh",
    platformUrl: tokenAddress ? `https://bnb.flap.sh/token/${tokenAddress}` : "https://bnb.flap.sh"
  };
}

function buildRegisteredVault(body) {
  if (body.caStore === "split") {
    let arr = [];
    try { arr = JSON.parse(body.splitRecipients || "[]"); } catch { throw new Error("splitRecipients invalid JSON"); }
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > 10) throw new Error("Split Vault butuh 1-10 recipients");
    let total = 0;
    const encoded = arr.map((x) => {
      if (!x.recipient || !ethers.isAddress(x.recipient)) throw new Error("Split recipient invalid");
      const bps = Number(x.bps || 0);
      if (bps <= 0) throw new Error("Split bps invalid");
      total += bps;
      return [x.recipient, bps];
    });
    if (total !== 10000) throw new Error("Total split bps harus 10000");
    const vaultData = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(address recipient,uint16 bps)[]"], [encoded.map(([recipient,bps]) => ({ recipient, bps }))]);
    return { vaultFactory: SPLIT_VAULT_FACTORY, vaultData };
  }

  if (body.caStore === "gift") {
    if (!body.xHandle) throw new Error("Gift Vault butuh xHandle");
    const vaultData = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(string xHandle)"], [{ xHandle: body.xHandle }]);
    return { vaultFactory: GIFT_VAULT_FACTORY, vaultData };
  }

  if (body.caStore === "custom") {
    if (!body.vaultFactory || !ethers.isAddress(body.vaultFactory)) throw new Error("Custom vaultFactory invalid");
    if (!body.vaultData || !body.vaultData.startsWith("0x")) throw new Error("Custom vaultData invalid");
    return { vaultFactory: body.vaultFactory, vaultData: body.vaultData };
  }

  return null;
}

app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/vault-options", (_, res) => {
  res.json({
    ok: true,
    options: [
      { id: "none", name: "None" },
      { id: "bnbshare", name: "BNB Share Vault" },
      { id: "split", name: "Split Vault", vaultFactory: SPLIT_VAULT_FACTORY },
      { id: "gift", name: "Gift Vault (FlapXVault)", vaultFactory: GIFT_VAULT_FACTORY },
      { id: "custom", name: "Custom Vault Factory" }
    ]
  });
});

app.get("/api/recent", (req, res) => {
  const mode = String(req.query.mode || "all");
  const source = String(req.query.source || "all");
  let items = readDB();
  if (source !== "all") items = items.filter(x => x.source === source);
  if (mode === "almost-bonded") {
    items = items.filter(x => (x.status || "new") !== "migrated");
    items.sort((a, b) => Number(b.progress || 0) - Number(a.progress || 0) || Number(b.createdAt || 0) - Number(a.createdAt || 0));
  } else {
    if (mode === "migrated") items = items.filter(x => x.status === "migrated");
    if (mode === "new") items = items.filter(x => (x.status || "new") === "new");
    items.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }
  res.json({ ok: true, items });
});

app.post("/api/processing", (_, res) => res.json({ ok: true, label: "processing" }));

app.post("/api/launch", upload.single("image"), async (req, res) => {
  let imagePath = null;
  try {
    const body = normalize(req.body);
    imagePath = req.file?.path || null;
    if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY belum diisi");

    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const quoteAmt = ethers.parseEther(String(body.devBuy || "0"));
    let meta = "";
    if (imagePath) {
      meta = await uploadMeta({ imagePath, description: body.description, website: body.website, twitter: body.twitter, telegram: body.telegram });
    }

    if (body.caStore === "bnbshare") {
      const payload = {
        name: body.name,
        symbol: body.symbol,
        metadataCid: meta,
        taxRate: Math.max(100, Math.min(1000, body.taxRate || 100)),
        quoteToken: "BNB",
        feeRecipients: [{ address: body.feeRecipientAddress || wallet.address, percent: 100 }],
        devBuyAmount: body.devBuy
      };
      const paramsRes = await axios.post(`${BNBSHARE_BASE}/token-params`, payload, { headers: { "Content-Type": "application/json" } });
      const d = paramsRes.data || {};
      const txReq = { to: d?.transaction?.to, data: d?.transaction?.data, value: d?.transaction?.value || "0x0" };
      if (!txReq.to || !txReq.data) throw new Error("bnbshare token-params invalid response");
      const tx = await wallet.sendTransaction(txReq);
      await tx.wait();
      const tokenAddress = d.predictedTokenAddress || "";
      addRecent(recentEntry(body, tx.hash, tokenAddress));
      return res.json({ ok: true, mode: "bnbshare", txHash: tx.hash, tokenAddress, bscscanTxUrl: `https://bscscan.com/tx/${tx.hash}`, chartUrl: tokenAddress ? `https://bnb.flap.sh/token/${tokenAddress}` : "", platformUrl: tokenAddress ? `https://bnb.flap.sh/token/${tokenAddress}` : "" });
    }

    if (body.caStore !== "none") {
      const rv = buildRegisteredVault(body);
      const contract = buildVaultPortalContract(wallet);
      const params = {
        name: body.name,
        symbol: body.symbol,
        meta,
        dexThresh: body.dexThresh,
        salt: randomSalt(),
        taxRate: body.taxRate || 100,
        migratorType: 1,
        quoteToken: body.quoteToken,
        quoteAmt,
        permitData: "0x",
        extensionID: ethers.ZeroHash,
        extensionData: "0x",
        dexId: body.dexId,
        lpFeeProfile: body.lpFeeProfile,
        taxDuration: body.taxDuration,
        antiFarmerDuration: body.antiFarmerDuration,
        mktBps: body.mktBps,
        deflationBps: body.deflationBps,
        dividendBps: body.dividendBps,
        lpBps: body.lpBps,
        minimumShareBalance: ethers.toBigInt(body.minimumShareBalance || "0"),
        vaultFactory: rv.vaultFactory,
        vaultData: rv.vaultData
      };
      await contract.newTaxTokenWithVault.estimateGas(params, { value: quoteAmt });
      const tx = await contract.newTaxTokenWithVault(params, { value: quoteAmt });
      const receipt = await tx.wait();
      const tokenAddress = receipt?.logs?.[0]?.address || "";
      addRecent(recentEntry(body, tx.hash, tokenAddress));
      return res.json({ ok: true, mode: "vault", txHash: tx.hash, tokenAddress, bscscanTxUrl: `https://bscscan.com/tx/${tx.hash}`, chartUrl: tokenAddress ? `https://bnb.flap.sh/token/${tokenAddress}` : "", platformUrl: tokenAddress ? `https://bnb.flap.sh/token/${tokenAddress}` : "" });
    }

    const contract = buildPortalContract(wallet);
    const params = {
      name: body.name,
      symbol: body.symbol,
      meta,
      dexThresh: body.dexThresh,
      salt: randomSalt(),
      taxRate: body.taxRate,
      migratorType: body.taxRate > 0 ? 1 : 0,
      quoteToken: body.quoteToken,
      quoteAmt,
      beneficiary: body.beneficiary || wallet.address,
      permitData: "0x",
      extensionID: ethers.ZeroHash,
      extensionData: "0x",
      dexId: body.dexId,
      lpFeeProfile: body.lpFeeProfile,
      taxDuration: body.taxDuration,
      antiFarmerDuration: body.antiFarmerDuration,
      mktBps: body.mktBps,
      deflationBps: body.deflationBps,
      dividendBps: body.dividendBps,
      lpBps: body.lpBps,
      minimumShareBalance: ethers.toBigInt(body.minimumShareBalance || "0")
    };
    await contract.newTokenV5.estimateGas(params, { value: quoteAmt });
    const tx = await contract.newTokenV5(params, { value: quoteAmt });
    const receipt = await tx.wait();
    const tokenAddress = receipt?.logs?.[0]?.address || "";
    addRecent(recentEntry(body, tx.hash, tokenAddress));
    res.json({ ok: true, mode: "direct", txHash: tx.hash, tokenAddress, bscscanTxUrl: `https://bscscan.com/tx/${tx.hash}`, chartUrl: tokenAddress ? `https://bnb.flap.sh/token/${tokenAddress}` : "", platformUrl: tokenAddress ? `https://bnb.flap.sh/token/${tokenAddress}` : "" });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.response?.data?.message || e?.response?.data?.error || e?.shortMessage || e?.reason || e?.message || "launch failed" });
  } finally {
    if (imagePath) { try { fs.unlinkSync(imagePath); } catch {} }
  }
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`BNBAgent registered vaults on ${PORT}`));
