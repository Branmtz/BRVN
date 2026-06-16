const nodemailer = require('nodemailer');
require('dotenv').config();

async function test() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const secure = process.env.SMTP_SECURE === 'true';

  console.log(`SMTP settings: ${host}:${port} secure=${secure} user=${user}`);

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });

  try {
    console.log('Verifying transporter...');
    await transporter.verify();
    console.log('Transporter verified successfully.');

    const mailOptions = {
      from: '"B R V N" <noreply@brvn.com.mx>',
      to: 'mrtinezbrandon@gmail.com',
      subject: 'Test Email',
      text: 'Test message'
    };

    console.log('Sending email...');
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.messageId);
  } catch (err) {
    console.error('Email sending failed:', err);
  } finally {
    process.exit(0);
  }
}

test();
