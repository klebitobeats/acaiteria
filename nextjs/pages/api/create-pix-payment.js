
const mercadopago = require("mercadopago");

mercadopago.configure({
  access_token: "TEST-4421698743839070-050603-b2ef49b07e81b9dcd5f751d3f3c6bd01-482595074"
});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Método não permitido." });
  }

  const { amount, description } = req.body;

  try {
    const payment = await mercadopago.payment.create({
      transaction_amount: parseFloat(amount),
      description: description || "Pagamento via Pix",
      payment_method_id: "pix",
      payer: {
        email: "test_user_123456@testuser.com" // Pode deixar assim para ambiente de teste
      }
    });

    const qrCodeUrl = payment.body.point_of_interaction.transaction_data.qr_code_url;

    res.status(200).json({ success: true, qr_code_url: qrCodeUrl });
  } catch (error) {
    console.error("Erro ao gerar pagamento PIX:", error.response ? error.response.data : error.message);
    res.status(500).json({ success: false, message: "Erro interno ao gerar PIX." });
  }
}
