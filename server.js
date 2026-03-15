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
const FLAP_UPLOAD_API = process.env.FLAP_UPLOAD_API || "https://funcs.flap.sh/api/upload";
const CUSTODY_ADDRESS = process.env.CUSTODY_ADDRESS || "";
const NON_TAX_IMPL = process.env.NON_TAX_IMPL || "0x8B4329947e34B6d56D71A3385caC122BaDe7d78D";
const TAX_IMPL = process.env.TAX_IMPL || "0x29e6383F0ce68507b5A72a53c2B118a118332aA8";
const DB_FILE = path.join(__dirname, "database.json");

const provider = new ethers.JsonRpcProvider(RPC);
const EIP1167_PREFIX = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

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
    variables: {
      file: null,
      meta: {
        description: description || "",
        website: website || "",
        twitter: twitter || "",
        telegram: telegram || "",
      },
    },
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
    "function newTokenV2((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint16 taxRate,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData)) payable returns (address)"
  ];
  return new ethers.Contract(FLAP_PORTAL, abi, wallet);
}

function buildBytecode(impl) {
  return EIP1167_PREFIX + impl.slice(2).toLowerCase() + EIP1167_SUFFIX;
}

function findVanitySalt(hasTax) {
  const suffix = hasTax ? "7777" : "8888";
  const impl = hasTax ? TAX_IMPL : NON_TAX_IMPL;
  const bytecodeHash = ethers.keccak256(buildBytecode(impl));
  let salt = ethers.keccak256(ethers.randomBytes(32));
  const maxIterations = 500000;

  for (let i = 0; i < maxIterations; i++) {
    const predicted = ethers.getCreate2Address(FLAP_PORTAL, salt, bytecodeHash);
    if (predicted.toLowerCase().endsWith(suffix)) {
      return { salt, predicted, suffix, iterations: i + 1 };
    }
    salt = ethers.keccak256(salt);
  }
  throw new Error(`could not find vanity salt ${suffix}`);
}

function normalize(body) {
  return {
    name: String(body.name || ""),
    symbol: String(body.symbol || ""),
    description: String(body.description || ""),
    website: body.website || "",
    twitter: body.twitter || "",
    telegram: body.telegram || "",
    beneficiary: body.beneficiary || "",
    taxRate: Number(body.taxRate || 0),
  };
}

app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/api/recent", (_, res) => res.json({ ok: true, items: readDB() }));

app.post("/api/processing", (req, res) => {
  try {
    const body = normalize(req.body || {});
    const hasTax = Number(body.taxRate || 0) > 0;
    const out = findVanitySalt(hasTax);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || "processing failed" });
  }
});

app.post("/api/launch", upload.single("image"), async (req, res) => {
  let imagePath = null;
  try {
    const body = normalize(req.body);
    imagePath = req.file?.path || null;

    if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY belum diisi");
    if (!body.name || !body.symbol) throw new Error("name/symbol wajib diisi");

    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    let cid = "";
    if (imagePath) {
      cid = await uploadMeta({
        imagePath,
        description: body.description,
        website: body.website,
        twitter: body.twitter,
        telegram: body.telegram,
      });
    }

    const hasTax = Number(body.taxRate || 0) > 0;
    const out = findVanitySalt(hasTax);
    const contract = buildPortalContract(wallet);

    const beneficiary = hasTax
      ? (CUSTODY_ADDRESS && ethers.isAddress(CUSTODY_ADDRESS) ? ethers.getAddress(CUSTODY_ADDRESS) : wallet.address)
      : (body.beneficiary && ethers.isAddress(body.beneficiary) ? ethers.getAddress(body.beneficiary) : wallet.address);

    const params = {
      name: body.name,
      symbol: body.symbol,
      meta: cid,
      dexThresh: 1,
      salt: out.salt,
      taxRate: body.taxRate,
      migratorType: hasTax ? 1 : 0,
      quoteToken: ethers.ZeroAddress,
      quoteAmt: 0n,
      beneficiary,
      permitData: "0x",
    };

    await contract.newTokenV2.estimateGas(params, { value: 0n });
    const tx = await contract.newTokenV2(params, { value: 0n });
    const receipt = await tx.wait();
    const tokenAddress = receipt?.logs?.[0]?.address || out.predicted;

    const entry = {
      status: "new",
      name: body.name,
      symbol: body.symbol,
      taxRate: body.taxRate,
      txHash: tx.hash,
      tokenAddress,
      chartUrl: `https://bnb.flap.sh/token/${tokenAddress}`,
      platformUrl: `https://bnb.flap.sh/token/${tokenAddress}`,
    };
    addRecent(entry);

    res.json({
      ok: true,
      txHash: tx.hash,
      tokenAddress,
      predicted: out.predicted,
      suffix: out.suffix,
      bscscanTxUrl: `https://bscscan.com/tx/${tx.hash}`,
      chartUrl: `https://bnb.flap.sh/token/${tokenAddress}`,
      platformUrl: `https://bnb.flap.sh/token/${tokenAddress}`,
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e?.response?.data?.message || e?.response?.data?.error || e?.shortMessage || e?.reason || e?.message || "launch failed"
    });
  } finally {
    if (imagePath) { try { fs.unlinkSync(imagePath); } catch {} }
  }
});

app.get("*", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`BNBAgent Flap basic V2 on ${PORT}`));
