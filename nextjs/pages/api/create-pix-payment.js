export default async function handler(req, res) {
  // Libera CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Responde requisição prévia do navegador
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // SDK do Mercado Pago
  const mercadopago = require("mercadopago");

  mercadopago.configure({
    access_token: "TEST-4421698743839070-050603-b2ef49b07e81b9dcd5f751d3f3c6bd01-482595074" // Troque aqui pelo seu token real do Mercado Pago
  });

  try {
    const body = {
      transaction_amount: 1,
      description: "Pedido Açaí",
      payment_method_id: "pix",
      payer: {
        email: "cliente_teste@email.com",
        first_name: "Cliente",
        last_name: "Teste",
        identification: {
          type: "CPF",
          number: "12345678909",
        },
      },
    };

    const payment = await mercadopago.payment.create({ body });

    const { id, point_of_interaction } = payment.response;

    res.status(200).json({
      id,
      qr_code_base64: point_of_interaction.transaction_data.qr_code_base64,
      qr_code: point_of_interaction.transaction_data.qr_code,
    });
  } catch (error) {
    console.error("Erro ao criar pagamento PIX:", error);
    res.status(500).json({ error: "Erro ao processar pagamento PIX" });
  }
}
