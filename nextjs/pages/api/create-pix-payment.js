
export default async function handler(req, res) {
  // Libera acesso do Firebase Hosting (substitua pelo domínio exato se quiser restringir)
  res.setHeader("Access-Control-Allow-Origin", "*"); 
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // resposta para preflight CORS
  }

  // Exemplo de payload simulado
  const { amount, description } = req.body;

  try {
    // Aqui iria a integração com Mercado Pago (teste)
    const fakeQrCodeUrl = "https://pix.qr.fake.url/123456";

    res.status(200).json({ success: true, qr_code_url: fakeQrCodeUrl });
  } catch (error) {
    console.error("Erro ao gerar pagamento PIX:", error);
    res.status(500).json({ success: false, message: "Erro interno ao gerar PIX." });
  }
}
