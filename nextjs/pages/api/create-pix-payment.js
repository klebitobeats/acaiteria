
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Exemplo de payload simulado — substitua isso com sua lógica real
  const { amount, description } = req.body;

  try {
    // Aqui iria a integração com Mercado Pago (ou outro serviço de pagamento)
    const fakeQrCodeUrl = "https://pix.qr.fake.url/123456";

    res.status(200).json({ success: true, qr_code_url: fakeQrCodeUrl });
  } catch (error) {
    console.error("Erro ao gerar pagamento PIX:", error);
    res.status(500).json({ success: false, message: "Erro interno ao gerar PIX." });
  }
}
