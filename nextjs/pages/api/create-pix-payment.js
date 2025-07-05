
export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // pré-verificação (preflight)
  }

  // Exemplo de payload simulado — substitua com lógica real de integração
  const { amount, description } = req.body;

  try {
    // Aqui você integraria com o Mercado Pago, Gerencianet, etc.
    const fakeQrCodeUrl = "https://pix.qr.fake.url/123456";

    res.status(200).json({ success: true, qr_code_url: fakeQrCodeUrl });
  } catch (error) {
    console.error("Erro ao gerar pagamento PIX:", error);
    res.status(500).json({ success: false, message: "Erro interno ao gerar PIX." });
  }
}
