const { default: axios } = require("axios");

async function sendTemplateMessage(phoneNumber = null, customTemplate = null) {
  try {
    // Check if WhatsApp token is configured
    if (!process.env.WHATSAPP_TOKEN) {
      console.error("❌ WHATSAPP_TOKEN not found in environment variables");
      throw new Error("WhatsApp token not configured");
    }

    // Validate phone number format (should be international format without +)
    const recipientNumber = phoneNumber || "923235205035";
    if (!recipientNumber.match(/^[0-9]{10,15}$/)) {
      console.error("❌ Invalid phone number format:", recipientNumber);
      throw new Error(
        "Invalid phone number format. Use international format without + (e.g., 923235205035)"
      );
    }

    const payload = {
      messaging_product: "whatsapp",
      to: recipientNumber,
      type: "template",
      template: customTemplate || {
        name: "jaspers_market_plain_text_v1",
        language: { code: "en_US" },
      },
    };

    console.log("📱 Sending WhatsApp message to:", recipientNumber);
    console.log("📄 Template:", payload.template.name);

    const response = await axios({
      url: "https://graph.facebook.com/v22.0/906858532514415/messages",
      method: "post",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      data: JSON.stringify(payload),
    });

    console.log("✅ WhatsApp message sent successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error("❌ WhatsApp message failed:");

    if (error.response) {
      // API responded with an error
      console.error("Status:", error.response.status);
      console.error("Error:", error.response.data);

      // Common WhatsApp API errors
      if (error.response.status === 401) {
        console.error("🔐 Authentication failed - Check your WhatsApp token");
      } else if (error.response.status === 400) {
        console.error(
          "📝 Bad request - Check template name, phone number format, or template approval"
        );
      } else if (error.response.status === 429) {
        console.error("⏱️ Rate limited - Too many messages sent");
      }
    } else if (error.request) {
      // Network error
      console.error("🌐 Network error - Check internet connection");
    } else {
      // Other error
      console.error("Error:", error.message);
    }

    throw error;
  }
}

// Test function to verify WhatsApp setup
async function testWhatsAppConnection() {
  try {
    console.log("🧪 Testing WhatsApp connection...");

    if (!process.env.WHATSAPP_TOKEN) {
      console.error(
        "❌ WHATSAPP_TOKEN not configured in environment variables"
      );
      return false;
    }

    // Test API connection
    const response = await axios.get(
      "https://graph.facebook.com/v22.0/906858532514415",
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
      }
    );

    console.log("✅ WhatsApp API connection successful:", response.data);
    return true;
  } catch (error) {
    console.error("❌ WhatsApp connection test failed:");
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Error:", error.response.data);
    } else {
      console.error("Error:", error.message);
    }
    return false;
  }
}

module.exports = {
  sendTemplateMessage,
  testWhatsAppConnection,
};
