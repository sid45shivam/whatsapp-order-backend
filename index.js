import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import PDFDocument from "pdfkit";
import fs from "fs";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Root route for testing
app.get("/", (req, res) => {
  res.send("WhatsApp backend is running.");
});

// WhatsApp API details from .env
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// Google AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Product list
const PRODUCTS = {
  "sugar": { price: 40 },
  "oil": { price: 120 },
  "rice": { price: 60 }
};

// ---------- AI PARSER ----------
async function parseOrderAI(message) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
Extract order items from this message.
Return JSON only.

Message: "${message}"

Example output:
{"product":"sugar","quantity":1,"unit":"kg"}
    `;

    const result = await model.generateContent(prompt);
    return JSON.parse(result.response.text());
  } catch (err) {
    console.log("AI error:", err);
    return null;
  }
}

// ---------- SEND MESSAGE ----------
async function sendWhatsapp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v17.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    },
    {
      headers: { Authorization: `Bearer ${TOKEN}` }
    }
  );
}

// ---------- GENERATE PDF ----------
function generateInvoice(order, fileName) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const path = `./${fileName}`;
    doc.pipe(fs.createWriteStream(path));

    doc.fontSize(20).text("Invoice", { align: "center" });
    doc.moveDown();
    doc.fontSize(14).text(`Product: ${order.product}`);
    doc.text(`Quantity: ${order.quantity} ${order.unit}`);
    doc.text(`Price: ₹${order.price}`);
    doc.text(`Total: ₹${order.total}`);

    doc.end();

    doc.on("finish", () => resolve(path));
  });
}

// ---------- WEBHOOK VERIFY ----------
app.get("/webhook/whatsapp", (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Verification attempt:", { mode, token });

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified!");
      return res.status(200).send(challenge);
    } else {
      console.log("Token mismatch. Expected:", VERIFY_TOKEN, "Got:", token);
      return res.sendStatus(403);
    }
  }

  res.sendStatus(400);
});

// ---------- WEBHOOK RECEIVE ----------
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const data = req.body;

    if (
      data.entry &&
      data.entry[0].changes &&
      data.entry[0].changes[0].value.messages
    ) {
      const msg = data.entry[0].changes[0].value.messages[0];
      const from = msg.from;
      const text = msg.text?.body || "";

      console.log("Message from user:", text);

      // Parse with AI
      const parsed = await parseOrderAI(text);
      if (!parsed) {
        await sendWhatsapp(from, "Sorry, I couldn't understand the order.");
        return res.sendStatus(200);
      }

      const product = PRODUCTS[parsed.product.toLowerCase()];
      if (!product) {
        await sendWhatsapp(from, "Product not found.");
        return res.sendStatus(200);
      }

      const order = {
        product: parsed.product,
        quantity: parsed.quantity,
        unit: parsed.unit,
        price: product.price,
        total: product.price * parsed.quantity,
      };

      const fileName = `invoice-${Date.now()}.pdf`;
      await generateInvoice(order, fileName);

      // Respond success
      await sendWhatsapp(from, `Order confirmed!\n\nProduct: ${order.product}\nTotal: ₹${order.total}`);

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.log("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
