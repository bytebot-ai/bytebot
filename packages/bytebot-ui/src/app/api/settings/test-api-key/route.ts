import { NextRequest } from "next/server";

// Configuration constants
const API_REQUEST_TIMEOUT_MS = 5000; // 5 seconds timeout

// Helper function to safely log errors without sensitive data
function logSafeError(message: string, error: any) {
  const safeErrorInfo = {
    message: message,
    errorType: error?.constructor?.name || 'Unknown',
    errorCode: error?.code,
    statusCode: error?.status,
    // Only log stack trace in development
    ...(process.env.NODE_ENV === 'development' && { stack: error?.stack })
  };
  
  console.error(safeErrorInfo);
  
  // TODO: Send to secure error monitoring service
  // Example: await sendToErrorMonitoring(safeErrorInfo);
}

// API endpoint to test API keys
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { provider, apiKey } = body;
    
    if (!provider || !apiKey) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Provider and API key are required" 
        }),
        { 
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    
    // Forward the request to the backend agent API
    const BYTEBOT_AGENT_BASE_URL = process.env.BYTEBOT_AGENT_BASE_URL || "http://localhost:3001";
    
    // Set up timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);
    
    let response;
    try {
      response = await fetch(`${BYTEBOT_AGENT_BASE_URL}/api-keys/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider, apiKey }),
        signal: controller.signal,
      });
      
      // Clear timeout on successful response
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      
      // Handle timeout specifically
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        logSafeError("API key test request timed out", { 
          timeout: API_REQUEST_TIMEOUT_MS,
          errorName: fetchError.name 
        });
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: `Request timed out after ${API_REQUEST_TIMEOUT_MS / 1000} seconds`,
            timeout: true
          }),
          { 
            status: 504, // Gateway Timeout
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      
      // Re-throw other fetch errors to be handled by outer catch
      throw fetchError;
    }
    
    // Handle response parsing safely
    let result;
    const contentType = response.headers.get('content-type');
    
    // Read response body as text first to avoid consuming the stream
    const responseText = await response.text().catch(() => "Unable to read response body");
    
    if (contentType && contentType.includes('application/json')) {
      try {
        result = JSON.parse(responseText);
      } catch (parseError) {
        logSafeError("Failed to parse JSON response from backend", parseError);
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: `Invalid JSON response from backend: ${responseText}`,
            status: response.status,
            statusText: response.statusText
          }),
          { 
            status: 502,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    } else {
      // Non-JSON response, return the text content
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: `Backend returned non-JSON response: ${responseText}`,
          status: response.status,
          statusText: response.statusText
        }),
        { 
          status: 502,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify(result),
      { 
        status: response.status,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    logSafeError("Error testing API key", error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: "Failed to test API key" 
      }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}