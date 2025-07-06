// api/create-pix.js
export default async function handler(req, res) {
  const mercadopago = require('mercadopago');

  mercadopago.configure({
    access_token: process.env.MP_ACCESS_TOKEN
  });

  const { total, nome, email } = req.body;

  try {
    const payment = await mercadopago.payment.create({
      transaction_amount: Number(total),
      description: "Pedido no App",
      payment_method_id: "pix",
      payer: {
        email: email || "comprador@teste.com",
        first_name: nome || "Cliente",
        identification: {
          type: "CPF",
          number: "19119119100" // CPF de teste do Mercado Pago
        }
      }
    });

    const { qr_code_base64, qr_code } = payment.body.point_of_interaction.transaction_data;
    return res.status(200).json({ qr_code_base64, qr_code, paymentId: payment.body.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao gerar Pix" });
  }
}
