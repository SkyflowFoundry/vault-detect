# 🔐 Skyflow De-identification and Tokenization Handler

This Node.js function processes sensitive files stored in a Skyflow vault by:
1. Retrieving a file (e.g., a document or image) from the vault,
2. Running it through a de-identification API to redact sensitive information,
3. Re-uploading the redacted file back to the vault,
4. Extracting detected entities (like credit card numbers),
5. Tokenizing the sensitive data back into Skyflow.

---

## 📦 Prerequisites

1. **Skyflow Vault** including schema contaning 1 table (e.g. `evidence`) and 4 columns (`user_id`, `original_file`, `processed_file`, `card_number`). 
2. **Node.js** secure function created. [Skyflow Documentation](https://docs.skyflow.com/management/#FunctionService_CreateFunction)
3. **Environment variables** defined: [Skyflow Documentation](https://docs.skyflow.com/management/#FunctionService_CreateFunctionEnvironment)
    - `account_id` – your Skyflow account ID
    - `vault_id` – your Skyflow vault ID
    - `account_url` – base URL of your Skyflow domain
4. **Dependencies** selected: `axios@1.6.5` & `form-data@2.4.0` or later.
5. **Function Deployment** triggered. [Skyflow Documentation](https://docs.skyflow.com/management/#FunctionService_CreateFunctionDeployment)

## 📥 Input Format
The function expects an event object with:
- `BodyContent`: Base64-encoded JSON with a `skyflow_id` key.
- `Headers`: Must include `X-Skyflow-Authorization`.
### 🔧 Sample Input
```curl
curl
--location --request POST '{{gatewayURL}}/v1/gateway/inboundRoutes/y9251bce47df400fa19a7a4cccdb3951/redact' \
--header 'X-SKYFLOW-ACCOUNT-ID: {{account_id}}' \
--header 'X-Skyflow-Authorization: {{bearer_token}}' \
--header 'Content-Type: application/json' \
--data '{"skyflow_id": "a0e2519b-ae21-4e98-8813-29041e8fe9d5"}'
```

## ✅ Output Format
### On Success:
```json
{
  "success": true,
  "steps": {
    "fileRead": true,
    "fileDeidentified": true,
    "fileWrite": true,
    "dataTokenize": true
  },
  "detectedEntityCount": 1,
  "tokens": {
    "card_number": "tok_xyz..."
  }
}
```
### On Failure:
```json
{
  "success": false,
  "steps": {
    "fileRead": true,
    "fileDeidentified": false,
    "fileWrite": false,
    "dataTokenize": false
  },
  "error": "Run failed: ..."
}
```

## 🔄 Flow Description
1. **Decode Input**: Decode and extract `skyflow_id`.
2. **Download File**: Retrieve original file from Skyflow vault via its ID.
3. **Call De-identification API**: Send file to a Skyflow `/deidentify/file` endpoint.
4. **Poll for Completion**: Wait until redaction is complete.
5. **Upload Redacted File**: Save the processed file back into Skyflow.
6. **Extract Entities**: Parse redacted metadata and extract card data.
7. **Tokenize Entity**: Send the detected entity (e.g., credit card) for tokenization.

## 🔍 Key Functions

| Function              | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `decodeInput()`       | Decodes Base64 input event                          |
| `getFileFromVault()`  | Downloads file from Skyflow vault                   |
| `callDeidApi()`       | Initiates de-identification API call                |
| `pollRunStatus()`     | Waits for redaction to complete                     |
| `uploadToVault()`     | Uploads redacted file to vault                      |
| `extractCreditCard()` | Extracts credit card number from redacted metadata  |
| `tokenizeCard()`      | Tokenizes extracted data using Skyflow tokenization |

## 🛠 Example Use Case
If you scan a receipt containing sensitive data like a credit card number:
- Upload it to Skyflow Vault.
- Call this function to:
  - Redact the number in the document,
  - Extract it as structured data,
  - Tokenize it securely.

## 🧯 Troubleshooting
- **Missing** `Authorization`: Ensure `X-Skyflow-Authorization` header is correctly set.
- **Invalid** `skyflow_id`: Verify the record exists and contains a file at the `original_file` column.
- **No output from de-id API**: Confirm the de-identification configuration supports your file type.
- **Polling timeout**: Large files or complex documents may need more time.
