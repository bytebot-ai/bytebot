"use client";

import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertCircle, CheckCircle, Save, TestTube, Shield, Eye, EyeOff } from "lucide-react";

interface ApiKeyConfig {
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  openrouterApiKey: string;
  mistralApiKey: string;
  cohereApiKey: string;
  groqApiKey: string;
  perplexityApiKey: string;
  togetherApiKey: string;
  deepseekApiKey: string;
  fireworksApiKey: string;
}

interface ApiKeyStatus {
  [key: string]: boolean; // true if key is configured on server
}

// Security warning component
const SecurityWarning = () => (
  <Card className="border-amber-200 bg-amber-50 mb-6">
    <CardHeader className="pb-3">
      <div className="flex items-center space-x-2">
        <Shield className="h-5 w-5 text-amber-600" />
        <CardTitle className="text-amber-800 text-sm">Security Notice</CardTitle>
      </div>
    </CardHeader>
    <CardContent className="pt-0">
      <p className="text-sm text-amber-700">
        API keys are securely stored on the server and never exposed to the browser. 
        You can verify which keys are configured without viewing their values.
      </p>
    </CardContent>
  </Card>
);

export default function SettingsPage() {
  // Only store input values temporarily (not persisted)
  const [apiConfig, setApiConfig] = useState<ApiKeyConfig>({
    anthropicApiKey: "",
    openaiApiKey: "",
    geminiApiKey: "",
    openrouterApiKey: "",
    mistralApiKey: "",
    cohereApiKey: "",
    groqApiKey: "",
    perplexityApiKey: "",
    togetherApiKey: "",
    deepseekApiKey: "",
    fireworksApiKey: "",
  });
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, { type: "success" | "error"; message: string } | null>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  // Fetch API key status from server (which keys are configured)
  useEffect(() => {
    const fetchApiKeyStatus = async () => {
      try {
        const response = await fetch("/api/settings/api-keys/status");
        if (response.ok) {
          const status = await response.json();
          setApiKeyStatus(status);
        }
      } catch (error) {
        console.error("Error fetching API key status:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchApiKeyStatus();
  }, []);

  // Helper function to render API key status indicator
  const renderKeyStatus = (keyName: keyof ApiKeyConfig) => {
    const isConfigured = apiKeyStatus[keyName];
    if (isConfigured) {
      return (
        <div className="flex items-center space-x-1 text-xs text-green-600">
          <CheckCircle className="h-3 w-3" />
          <span>Configured</span>
        </div>
      );
    }
    return (
      <div className="flex items-center space-x-1 text-xs text-gray-500">
        <AlertCircle className="h-3 w-3" />
        <span>Not configured</span>
      </div>
    );
  };

  const handleInputChange = (field: keyof ApiKeyConfig, value: string) => {
    setApiConfig(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus(null);
    
    try {
      // Only send non-empty API keys to backend
      const keysToSave = Object.entries(apiConfig).reduce((acc, [key, value]) => {
        if (value.trim()) {
          (acc as any)[key] = value;
        }
        return acc;
      }, {} as Partial<ApiKeyConfig>);

      // Send to backend for secure server-side storage
      const response = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(keysToSave),
      });
      
      if (response.ok) {
        setSaveStatus({
          type: "success",
          message: "API keys saved securely on server!"
        });
        
        // Clear input fields after successful save
        setApiConfig({
          anthropicApiKey: "",
          openaiApiKey: "",
          geminiApiKey: "",
          openrouterApiKey: "",
          mistralApiKey: "",
          cohereApiKey: "",
          groqApiKey: "",
          perplexityApiKey: "",
          togetherApiKey: "",
          deepseekApiKey: "",
          fireworksApiKey: "",
        });
        
        // Refresh API key status
        const statusResponse = await fetch("/api/settings/api-keys/status");
        if (statusResponse.ok) {
          const status = await statusResponse.json();
          setApiKeyStatus(status);
        }
      } else {
        const errorData = await response.json();
        setSaveStatus({
          type: "error",
          message: errorData.error || "Failed to save API keys"
        });
      }
    } catch (error) {
      setSaveStatus({
        type: "error",
        message: "Failed to save API keys: " + (error as Error).message
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestApiKey = async (provider: string, apiKey: string) => {
    if (!apiKey) {
      setTestStatus(prev => ({
        ...prev,
        [provider]: {
          type: "error",
          message: "Please enter an API key first"
        }
      }));
      return;
    }

    setTestStatus(prev => ({
      ...prev,
      [provider]: {
        type: "success",
        message: "Testing..."
      }
    }));

    try {
      const response = await fetch("/api/settings/test-api-key", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider, apiKey }),
      });

      const result = await response.json();

      setTestStatus(prev => ({
        ...prev,
        [provider]: result.success 
          ? { type: "success", message: "API key is valid!" } 
          : { type: "error", message: result.error || "Invalid API key" }
      }));
    } catch (error) {
      setTestStatus(prev => ({
        ...prev,
        [provider]: {
          type: "error",
          message: "Error testing API key: " + (error as Error).message
        }
      }));
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />
      
      <main className="flex flex-1 flex-col overflow-y-auto p-4 md:p-8">
        <div className="mx-auto w-full max-w-4xl">
          <div className="mb-6">
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-muted-foreground">Configure your API keys and preferences</p>
          </div>

          {saveStatus && (
            <div className={`mb-6 p-3 rounded-lg border ${saveStatus.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
              <div className="flex items-center gap-2">
                {saveStatus.type === "error" ? (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                ) : (
                  <CheckCircle className="h-4 w-4 text-green-600" />
                )}
                <span className="text-sm">{saveStatus.message}</span>
              </div>
            </div>
          )}

          <SecurityWarning />

          <Card>
            <CardHeader>
              <CardTitle>API Configuration</CardTitle>
              <CardDescription>
                Add your API keys for various providers to use with Bytebot
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="openrouter" className="w-full">
                <TabsList className="grid w-full grid-cols-3 lg:grid-cols-4">
                  <TabsTrigger value="openrouter">OpenRouter</TabsTrigger>
                  <TabsTrigger value="openai">OpenAI</TabsTrigger>
                  <TabsTrigger value="anthropic">Anthropic</TabsTrigger>
                  <TabsTrigger value="google">Google</TabsTrigger>
                </TabsList>
                
                <TabsContent value="openrouter" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="openrouterApiKey">OpenRouter API Key</Label>
                      {renderKeyStatus("openrouterApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="openrouterApiKey"
                        type="password"
                        placeholder={apiKeyStatus.openrouterApiKey ? "••••••••••••••••" : "sk-or-v1-..."}
                        value={apiConfig.openrouterApiKey}
                        onChange={(e) => handleInputChange("openrouterApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("openrouter", apiConfig.openrouterApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.openrouter && (
                      <div className={`p-3 rounded-lg border ${testStatus.openrouter.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.openrouter.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.openrouter.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      OpenRouter provides access to many free models and top-tier models from various providers.
                      Get your key from{' '}
                      <a 
                        href="https://openrouter.ai/keys" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        openrouter.ai
                      </a>
                    </p>
                  </div>
                </TabsContent>
                
                <TabsContent value="openai" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="openaiApiKey">OpenAI API Key</Label>
                      {renderKeyStatus("openaiApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="openaiApiKey"
                        type="password"
                        placeholder={apiKeyStatus.openaiApiKey ? "••••••••••••••••" : "sk-..."}
                        value={apiConfig.openaiApiKey}
                        onChange={(e) => handleInputChange("openaiApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("openai", apiConfig.openaiApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.openai && (
                      <div className={`p-3 rounded-lg border ${testStatus.openai.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.openai.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.openai.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your OpenAI API key from{' '}
                      <a 
                        href="https://platform.openai.com/api-keys" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        platform.openai.com
                      </a>
                    </p>
                  </div>
                </TabsContent>
                
                <TabsContent value="anthropic" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="anthropicApiKey">Anthropic API Key</Label>
                      {renderKeyStatus("anthropicApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="anthropicApiKey"
                        type="password"
                        placeholder={apiKeyStatus.anthropicApiKey ? "••••••••••••••••" : "sk-ant-..."}
                        value={apiConfig.anthropicApiKey}
                        onChange={(e) => handleInputChange("anthropicApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("anthropic", apiConfig.anthropicApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.anthropic && (
                      <div className={`p-3 rounded-lg border ${testStatus.anthropic.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.anthropic.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.anthropic.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your Anthropic API key from{' '}
                      <a 
                        href="https://console.anthropic.com/settings/keys" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        console.anthropic.com
                      </a>
                    </p>
                  </div>
                </TabsContent>
                
                <TabsContent value="google" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="geminiApiKey">Google Gemini API Key</Label>
                      {renderKeyStatus("geminiApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="geminiApiKey"
                        type="password"
                        placeholder={apiKeyStatus.geminiApiKey ? "••••••••••••••••" : "AIza..."}
                        value={apiConfig.geminiApiKey}
                        onChange={(e) => handleInputChange("geminiApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("gemini", apiConfig.geminiApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.gemini && (
                      <div className={`p-3 rounded-lg border ${testStatus.gemini.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.gemini.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.gemini.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your Google Gemini API key from{' '}
                      <a 
                        href="https://aistudio.google.com/app/apikey" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        aistudio.google.com
                      </a>
                    </p>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="mistralApiKey">Mistral API Key</Label>
                      {renderKeyStatus("mistralApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="mistralApiKey"
                        type="password"
                        placeholder={apiKeyStatus.mistralApiKey ? "••••••••••••••••" : "mistral-..."}
                        value={apiConfig.mistralApiKey}
                        onChange={(e) => handleInputChange("mistralApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("mistral", apiConfig.mistralApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.mistral && (
                      <div className={`p-3 rounded-lg border ${testStatus.mistral.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.mistral.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.mistral.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your Mistral API key from{' '}
                      <a 
                        href="https://console.mistral.ai/api-keys/" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        console.mistral.ai
                      </a>
                    </p>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="cohereApiKey">Cohere API Key</Label>
                      {renderKeyStatus("cohereApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="cohereApiKey"
                        type="password"
                        placeholder={apiKeyStatus.cohereApiKey ? "••••••••••••••••" : "CO-..."}
                        value={apiConfig.cohereApiKey}
                        onChange={(e) => handleInputChange("cohereApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("cohere", apiConfig.cohereApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.cohere && (
                      <div className={`p-3 rounded-lg border ${testStatus.cohere.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.cohere.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.cohere.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your Cohere API key from{' '}
                      <a 
                        href="https://dashboard.cohere.com/api-keys" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        dashboard.cohere.com
                      </a>
                    </p>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="groqApiKey">Groq API Key</Label>
                      {renderKeyStatus("groqApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="groqApiKey"
                        type="password"
                        placeholder={apiKeyStatus.groqApiKey ? "••••••••••••••••" : "gsk_..."}
                        value={apiConfig.groqApiKey}
                        onChange={(e) => handleInputChange("groqApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("groq", apiConfig.groqApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.groq && (
                      <div className={`p-3 rounded-lg border ${testStatus.groq.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.groq.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.groq.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your Groq API key from{' '}
                      <a 
                        href="https://console.groq.com/keys" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        console.groq.com
                      </a>
                    </p>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="perplexityApiKey">Perplexity API Key</Label>
                      {renderKeyStatus("perplexityApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="perplexityApiKey"
                        type="password"
                        placeholder={apiKeyStatus.perplexityApiKey ? "••••••••••••••••" : "pplx-..."}
                        value={apiConfig.perplexityApiKey}
                        onChange={(e) => handleInputChange("perplexityApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("perplexity", apiConfig.perplexityApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.perplexity && (
                      <div className={`p-3 rounded-lg border ${testStatus.perplexity.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.perplexity.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.perplexity.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your Perplexity API key from{' '}
                      <a 
                        href="https://www.perplexity.ai/settings/api" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        perplexity.ai
                      </a>
                    </p>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="togetherApiKey">Together AI API Key</Label>
                      {renderKeyStatus("togetherApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="togetherApiKey"
                        type="password"
                        placeholder={apiKeyStatus.togetherApiKey ? "••••••••••••••••" : "8a7a6f2e-..."}
                        value={apiConfig.togetherApiKey}
                        onChange={(e) => handleInputChange("togetherApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("together", apiConfig.togetherApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.together && (
                      <div className={`p-3 rounded-lg border ${testStatus.together.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.together.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.together.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your Together AI API key from{' '}
                      <a 
                        href="https://api.together.xyz/settings" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        api.together.xyz
                      </a>
                    </p>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="deepseekApiKey">DeepSeek API Key</Label>
                      {renderKeyStatus("deepseekApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="deepseekApiKey"
                        type="password"
                        placeholder={apiKeyStatus.deepseekApiKey ? "••••••••••••••••" : "sk-..."}
                        value={apiConfig.deepseekApiKey}
                        onChange={(e) => handleInputChange("deepseekApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("deepseek", apiConfig.deepseekApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.deepseek && (
                      <div className={`p-3 rounded-lg border ${testStatus.deepseek.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.deepseek.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.deepseek.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your DeepSeek API key from{' '}
                      <a 
                        href="https://platform.deepseek.com/api_keys" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        platform.deepseek.com
                      </a>
                    </p>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="fireworksApiKey">Fireworks AI API Key</Label>
                      {renderKeyStatus("fireworksApiKey")}
                    </div>
                    <div className="flex space-x-2">
                      <Input
                        id="fireworksApiKey"
                        type="password"
                        placeholder={apiKeyStatus.fireworksApiKey ? "••••••••••••••••" : "fk-..."}
                        value={apiConfig.fireworksApiKey}
                        onChange={(e) => handleInputChange("fireworksApiKey", e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleTestApiKey("fireworks", apiConfig.fireworksApiKey)}
                        disabled={isSaving}
                      >
                        <TestTube className="h-4 w-4 mr-2" />
                        Test
                      </Button>
                    </div>
                    {testStatus.fireworks && (
                      <div className={`p-3 rounded-lg border ${testStatus.fireworks.type === "error" ? "border-destructive bg-destructive/10" : "border-green-500/30 bg-green-500/10"}`}>
                        <div className="flex items-center gap-2">
                          {testStatus.fireworks.type === "error" ? (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          )}
                          <span className="text-sm">{testStatus.fireworks.message}</span>
                        </div>
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Get your Fireworks AI API key from{' '}
                      <a 
                        href="https://fireworks.ai/api-keys" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        fireworks.ai
                      </a>
                    </p>
                  </div>
                </TabsContent>
              </Tabs>

              <div className="mt-6 flex justify-end">
                <Button onClick={handleSave} disabled={isSaving}>
                  <Save className="h-4 w-4 mr-2" />
                  {isSaving ? "Saving..." : "Save Configuration"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}