// ================================================================
//  THERMOCHAIN SOLUTIONS — API Backend Node.js
//  Recibe datos de Arduino y gestiona la BD MariaDB
//  
//  Instalación:
//    npm install express mysql2 cors dotenv nodemailer serialport
//  Ejecución:
//    node server.js
// ================================================================

const express    = require('express');
const mysql      = require('mysql2/promise');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const path       = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ================================================================
// CONEXIÓN MARIADB
// ================================================================
const pool = mysql.createPool({
  host     : process.env.DB_HOST     || 'localhost',
  port     : process.env.DB_PORT     || 3306,
  user     : process.env.DB_USER     || 'thermochain',
  password : process.env.DB_PASS     || 'ThermoChain2024!',
  database : process.env.DB_NAME     || 'thermochain',
  waitForConnections: true,
  connectionLimit   : 10,
  timezone          : 'local'
});

async function testDB() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Conexión MySQL/MariaDB establecida');
    conn.release();
  } catch (err) {
    console.error('❌ Error conectando a MySQL:', err.message);
    console.log('⚠️  El servidor continúa sin BD. Reintentando en cada request...');
    // No llamar process.exit(1) — el servidor sigue corriendo
  }
}

// ================================================================
// NODEMAILER — SMTP GMAIL
// ================================================================
const mailer = nodemailer.createTransport({
  host  : 'smtp.gmail.com',
  port  : 587,
  secure: false,
  auth  : {
    user: 'thermochainsolutions@gmail.com',
    pass: 'irrw pwav yesp qmcx'   // Google App Password
  }
});

async function enviarAlertaEmail({ punto, tipo, mensaje, valor, temperatura, humedad }) {
  const destinos = (process.env.ALERT_EMAILS || '').split(',').filter(Boolean);
  if (!destinos.length) return;

  const severidadColor = tipo === 'FALLO_ENERGIA' || tipo.includes('TEMP') ? '#ff3a3a' : '#ffb400';
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;background:#040d18;color:#c8dff0;padding:24px;border-radius:8px;border:1px solid #0a3060">
    <div style="border-bottom:2px solid ${severidadColor};padding-bottom:14px;margin-bottom:20px">
      <img src="cid:logo" style="height:32px" alt="ThermoChain"/>
      <h1 style="color:${severidadColor};font-size:18px;margin:8px 0">⚠ ALERTA ${tipo.replace('_',' ')}</h1>
      <p style="color:#4a7090;font-size:12px;margin:0">
        ${new Date().toLocaleString('es-PA', { timeZone: 'America/Panama' })}
      </p>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:8px;color:#4a7090;width:40%">Punto de frío:</td>
          <td style="padding:8px;color:#e8f4ff"><strong>${punto.codigo} — ${punto.nombre}</strong></td></tr>
      <tr><td style="padding:8px;color:#4a7090">Ubicación:</td>
          <td style="padding:8px;color:#e8f4ff">${punto.ubicacion}</td></tr>
      <tr><td style="padding:8px;color:#4a7090">Temperatura:</td>
          <td style="padding:8px;color:${severidadColor}"><strong>${temperatura}°C</strong>
            (rango: ${punto.temp_min}°C — ${punto.temp_max}°C)</td></tr>
      <tr><td style="padding:8px;color:#4a7090">Humedad:</td>
          <td style="padding:8px;color:#e8f4ff">${humedad}%RH</td></tr>
      <tr style="background:rgba(255,58,58,0.1)">
          <td style="padding:10px;color:#4a7090">Evento:</td>
          <td style="padding:10px;color:${severidadColor}"><strong>${mensaje}</strong></td></tr>
    </table>
    <div style="margin-top:20px;padding:14px;background:rgba(255,58,58,0.1);border-left:3px solid ${severidadColor};border-radius:4px">
      <p style="color:#e8f4ff;margin:0;font-size:13px">
        <strong>Se requiere intervención inmediata.</strong><br>
        Los productos almacenados pueden estar en riesgo. Verifique el punto de frío y tome acciones correctivas.
      </p>
    </div>
    <p style="color:#4a7090;font-size:11px;margin-top:20px;border-top:1px solid #0a3060;padding-top:12px">
      ThermoChain Solutions — Sistema Automático de Alertas<br>
      No responder a este correo. Para soporte: soporte@thermochain.com
    </p>
  </div>`;

  await mailer.sendMail({
    from   : `"ThermoChain Alertas" <${process.env.SMTP_USER}>`,
    to     : destinos.join(', '),
    subject: `🔴 [ThermoChain] ALERTA ${tipo} — ${punto.codigo}`,
    html
  });
}

// ================================================================
// MIDDLEWARE: VALIDAR TOKEN ARDUINO
// ================================================================
async function validarToken(req, res, next) {
  const token = req.headers['x-arduino-token'] || req.body.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const [rows] = await pool.query(
      'SELECT d.*, p.* FROM dispositivos_arduino d JOIN puntos_frio p ON p.id = d.punto_id WHERE d.token_api = ? AND d.activo = 1',
      [token]
    );
    if (!rows.length) return res.status(403).json({ error: 'Token inválido' });

    // Actualizar última conexión
    await pool.query(
      'UPDATE dispositivos_arduino SET ultima_conexion = NOW(), ip_ultima = ? WHERE token_api = ?',
      [req.ip, token]
    );

    req.dispositivo = rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error de autenticación' });
  }
}

// ================================================================
// RUTAS API — ARDUINO
// ================================================================

/**
 * POST /api/lectura
 * El Arduino envía sus datos aquí cada N segundos
 * 
 * Headers: x-arduino-token: TC_TOKEN_PC01_...
 * Body: {
 *   temperatura: -4.5,
 *   humedad: 45.2,
 *   energia_ok: 1,
 *   puerta_abierta: 0,
 *   voltaje: 4.95     (opcional)
 * }
 */
app.post('/api/lectura', validarToken, async (req, res) => {
  const { temperatura, humedad, energia_ok, puerta_abierta, voltaje } = req.body;
  const punto = req.dispositivo;

  if (temperatura === undefined || humedad === undefined) {
    return res.status(400).json({ error: 'Campos requeridos: temperatura, humedad' });
  }

  const conn = await pool.getConnection();
  try {
    // Llamar al procedimiento almacenado
    const [result] = await conn.query(
      'CALL sp_insertar_lectura(?, ?, ?, ?, ?, ?, @lectura_id, @alertas); SELECT @lectura_id as lectura_id, @alertas as alertas_json',
      [punto.id, temperatura, humedad, energia_ok ?? 1, puerta_abierta ?? 0, voltaje ?? null]
    );

    const { lectura_id, alertas_json } = result[1][0];
    const alertas = JSON.parse(alertas_json || '[]');

    // Enviar emails si hay alertas críticas
    if (alertas.includes('FALLO_ENERGIA') || alertas.some(a => a.includes('TEMP'))) {
      try {
        await enviarAlertaEmail({
          punto,
          tipo    : alertas[0],
          mensaje : `Alerta en ${punto.nombre}: ${alertas.join(', ')}`,
          valor   : temperatura,
          temperatura,
          humedad
        });
        // Marcar email como enviado
        await conn.query(
          'UPDATE alertas SET email_enviado = 1, email_destino = ? WHERE punto_id = ? AND email_enviado = 0 AND creada_en >= NOW() - INTERVAL 1 MINUTE',
          [process.env.ALERT_EMAILS, punto.id]
        );
      } catch (emailErr) {
        console.error('⚠ Error enviando email:', emailErr.message);
      }
    }

    res.json({ ok: true, lectura_id, alertas });
  } catch (err) {
    console.error('Error insertando lectura:', err);
    res.status(500).json({ error: 'Error al guardar lectura' });
  } finally {
    conn.release();
  }
});

// ================================================================
// RUTAS API — DASHBOARD (Frontend)
// ================================================================

// GET /api/dashboard — Estado actual de todos los puntos
app.get('/api/dashboard', async (req, res) => {
  try {
    const [puntos] = await pool.query('SELECT * FROM v_ultima_lectura');
    const [alertas] = await pool.query('SELECT * FROM v_alertas_activas LIMIT 50');
    const [stats]   = await pool.query('SELECT * FROM v_stats_24h');
    res.json({ puntos, alertas, stats, timestamp: new Date() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/puntos/:id/lecturas — Historial de lecturas de un punto
app.get('/api/puntos/:id/lecturas', async (req, res) => {
  const horas  = Math.min(parseInt(req.query.horas  ?? 24), 168);
  const limite = Math.min(parseInt(req.query.limite ?? 200), 1000);
  try {
    const [rows] = await pool.query(
      `SELECT temperatura, humedad, energia_ok, puerta_abierta, leido_en
       FROM lecturas
       WHERE punto_id = ? AND leido_en >= NOW() - INTERVAL ? HOUR
       ORDER BY leido_en ASC LIMIT ?`,
      [req.params.id, horas, limite]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alertas — Alertas con filtros
app.get('/api/alertas', async (req, res) => {
  const { resuelta = 0, limite = 100 } = req.query;
  try {
    const [rows] = await pool.query(
      `SELECT a.*, p.codigo, p.nombre
       FROM alertas a JOIN puntos_frio p ON p.id = a.punto_id
       WHERE a.resuelta = ? ORDER BY a.creada_en DESC LIMIT ?`,
      [resuelta, parseInt(limite)]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/alertas/:id/resolver
app.patch('/api/alertas/:id/resolver', async (req, res) => {
  try {
    await pool.query(
      'UPDATE alertas SET resuelta = 1, resuelta_en = NOW() WHERE id = ?',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/smtp/test — Probar configuración SMTP
app.post('/api/smtp/test', async (req, res) => {
  const { email } = req.body;
  try {
    await mailer.sendMail({
      from   : `"ThermoChain Alertas" <${process.env.SMTP_USER}>`,
      to     : email,
      subject: '✅ ThermoChain — Prueba de Conexión SMTP',
      html   : '<p>La configuración SMTP de ThermoChain Solutions está funcionando correctamente.</p>'
    });
    res.json({ ok: true, mensaje: 'Email de prueba enviado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// INICIO
// ================================================================

// ================================================================
// INICIO — Servidor arranca siempre, BD conecta después
// ================================================================
app.listen(PORT, () => {
  console.log(`✅ ThermoChain Solutions API corriendo en puerto ${PORT}`);
});

testDB();
