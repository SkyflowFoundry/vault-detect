const axios = require('axios');
const FormData = require('form-data');

const table_name = "evidence";
const col_name = "original_file";

function decodeInput(event) {
  if (!event.BodyContent) throw new Error('BodyContent missing');
  return JSON.parse(Buffer.from(event.BodyContent, 'base64').toString());
}

function constructHeaders(account_id, auth_token) {
  return {
    'X-SKYFLOW-ACCOUNT-ID': account_id,
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth_token}`
  };
}

function getFileExtensionFromURL(fileUrl) {
  const parsed = new URL(fileUrl);
  const disposition = parsed.searchParams.get('response-content-disposition');
  
  if (disposition) {
    const match = disposition.match(/filename=([^;]+)/);
    if (match) {
      const filename = decodeURIComponent(match[1]).trim();
      const ext = filename.split('.').pop();
      return ext.toLowerCase();
    }
  }

  return null;
}

async function getFileFromVault(skyflow_id, account_id, auth_token, vault_id, account_url) {
  const id = skyflow_id;
  if (!id) throw new Error('Missing skyflow_id');

  const downloadUrlRes = await axios.get(
    `${account_url}/v1/vaults/${vault_id}/${table_name}/${id}?downloadURL=true`,
    { headers: { 'X-SKYFLOW-ACCOUNT-ID': account_id, 'Authorization': `Bearer ${auth_token}` } }
  );

  const dl = downloadUrlRes.data.fields[col_name];
  if (!dl) throw new Error('No downloadURL');

  const fileRes = await axios.get(dl, { responseType: 'arraybuffer' });
  const fileBase64 = Buffer.from(fileRes.data, 'binary').toString('base64');

  const fileType = getFileExtensionFromURL(dl);

  return { fileBase64, data_format: fileType };
}

async function callDeidApi(url, payload, headers) {
  const r = await axios.post(url, payload, { headers });
  return r.data;
}

async function pollRunStatus(url, headers) {
  let status, resp;
  const delay = 1000;
  const maxAttempts = 300;
  let attempts = 0;

  do {
    await new Promise(r => setTimeout(r, delay));
    attempts++;

    const r = await axios.get(url, { headers });
    resp = r.data;
    status = resp.status;

    if (status === 'FAILED') throw new Error(`Run failed: ${JSON.stringify(resp.error || {})}`);
    if (attempts >= maxAttempts) throw new Error('Polling timed out');
  } while (status !== 'SUCCESS');

  return resp;
}

async function uploadToVault(vault_id, skyflow_id, account_id, auth_token, base64File, data_format, account_url) {
  const url = `${account_url}/v1/vaults/${vault_id}/${table_name}/${skyflow_id}/files`;
  const form = new FormData();
  const ext = data_format.toLowerCase();
  form.append('processed_file', Buffer.from(base64File, 'base64'), {
    filename: `redacted.${ext}`,
    contentType: `application/${ext}`
  });

  const headers = form.getHeaders();
  headers['X-SKYFLOW-ACCOUNT-ID'] = account_id;
  headers['Authorization'] = `Bearer ${auth_token}`;

  const r = await axios.post(url, form, { headers });
  return r.data;
}

function extractCreditCard(base64String) {
  try {
    // Step 1: Decode base64 to string
    const jsonString = Buffer.from(base64String, 'base64').toString('utf-8');

    // Step 2: Parse JSON
    const dataArray = JSON.parse(jsonString);

    // Step 3: Find the element with best_label = "CREDIT_CARD"
    const creditCardItem = dataArray.find(item => item.best_label === "CREDIT_CARD"); 

    // Step 4: Return only the "text" field in the expected format
    if (creditCardItem && creditCardItem.text) {
      const cardNumber = creditCardItem.text.replace(/\D/g, '').slice(0, 16);
      return { card_number: cardNumber };
    }

    return null; // Return null if not found
  } catch (error) {
    console.error("Failed to decode or parse input:", error);
    return null;
  }
}

async function tokenizeCard(vault_id, skyflow_id, account_id, auth_token, account_url, cardData) {
  try {
    const url = `${account_url}/v1/vaults/${vault_id}/${table_name}/${skyflow_id}`;
    const payload =   
      {
        "record": {
            "fields": cardData
        },
    "tokenization": true
      };

    const headers = {
      'Authorization': `Bearer ${auth_token}`,
      'X-SKYFLOW-ACCOUNT-ID': account_id,
      'Content-Type': 'application/json'
    };

    const r = await axios.put(url, payload, { headers });

    const tokenizedCard = r.data.tokens;
    return tokenizedCard;
  } catch (error) {
    console.error("Skyflow insert failed:", error.response?.data || error.message);
    throw new Error("Insert failed");
  }
}

exports.skyflowmain = async (event) => {
  const steps = { fileRead: false, fileDeidentified: false, fileWrite: false, dataTokenize: false };
  let entities = null;
  try {
    
    const req = decodeInput(event);
    const { skyflow_id } = req;

    const { account_url, account_id, vault_id } = process.env;

    // Use headers to access the connection headers.
    const apiHeaders = event.Headers;
    const authorizationHeaderValue = apiHeaders['X-Skyflow-Authorization'];
    const auth_token = authorizationHeaderValue[0];

    const { fileBase64, data_format } = await getFileFromVault(skyflow_id, account_id, auth_token, vault_id, account_url);
    steps.fileRead = true;

    const headers = constructHeaders(account_id, auth_token);
    const payload = {
      file: { base64: fileBase64, data_format },
      vault_id
    };

    const apiResponse = await callDeidApi(`${account_url}/v1/detect/deidentify/file`, payload, headers);
    const runId = apiResponse.run_id;
    if (!runId) throw new Error('No run_id');

    const polled = await pollRunStatus(`${account_url}/v1/detect/runs/${runId}?vault_id=${vault_id}`, headers);
    steps.fileDeidentified = true;

    let base64Out = null;
    for (const it of polled.output) {
      if (it.processed_file_type?.startsWith('redacted_')) base64Out = it.processed_file;
      else if (it.processed_file_type === 'entities') entities = it.processed_file;
    }

    if (!base64Out) throw new Error('No redacted output');

    await uploadToVault(vault_id, skyflow_id, account_id, auth_token, base64Out, data_format, account_url);
    steps.fileWrite = true;

    let detectedEntityCount = 0;
    if (entities) {
      const entitiesArray = JSON.parse(Buffer.from(entities, 'base64').toString());
      detectedEntityCount = entitiesArray.length;
    }

    const detectedEntities = extractCreditCard(entities);
    const tokens = await tokenizeCard(vault_id, skyflow_id, account_id, auth_token, account_url, detectedEntities)
    steps.dataTokenize = true

    return { success: true, steps, detectedEntityCount, tokens };
  } catch (err) {
    return { success: false, steps, error: err.message };
  }
};