import { createServer } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { createHttpLogger } from "../middleware/logger.js";

describe("HTTP logger credential redaction", () => {
  it.each([200,400,500])("keeps Muse OAuth and task payloads out of %i diagnostics",async status=>{
    const chunks:string[]=[];
    const stream=new Writable({write(chunk,_encoding,callback){chunks.push(chunk.toString());callback();}});
    const app=express();app.use(createHttpLogger(pino({redact:[...HTTP_LOG_REDACT_PATHS]},stream)));app.use(express.json());
    const canary="private-muse-payload-canary";
    app.use((_req,res)=>{res.setHeader("Location","https://client.example/callback?code="+canary);res.setHeader("x-provider-prose",canary);if(status>=400)(res as any).err=new Error(canary);res.status(status).json({error:status>=400?"invalid_request":undefined});});
    await request(app).get("/api/muse/v1/oauth/authorize").query({pairing_ticket:canary,state:canary}).set("Referer","https://client.example/?code="+canary);
    for(const path of ["/api/muse/v1/oauth/token","/api/muse/v1/commands","/api/muse/unknown/"+canary])await request(app).post(path).set("Authorization","Bearer "+canary).send({code:canary,code_verifier:canary,refresh_token:canary,arguments:{description:canary}});
    const output=chunks.join("");expect(output).not.toContain(canary);
    const logs=chunks.flatMap(chunk=>chunk.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)));
    expect(logs.length).toBe(4);for(const log of logs){expect(log.req.url).toBe("/api/muse/:protocol");if(status>=400)expect(log.reqBody).toBe("[REDACTED]");}
  });

  it.each([400, 503])("omits transfer payloads and provider diagnostics for status %s", async (status) => {
    const canary = "transfer-private-canary-2345";
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    const app = express();
    app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
    app.use(express.json());
    app.use((req, res) => {
      (res as any).err = new Error(canary);
      (res as any).__errorContext = { error: { message: canary }, reqBody: req.body, reqParams: { value: canary } };
      res.setHeader("x-provider-diagnostic", canary);
      res.status(status).end();
    });
    const server = createServer(app);
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      await request(server).post(`/api/companies/company/credential-transfers/${canary}?value=${canary}`)
        .set("x-paperclip-tool-gateway-token", canary).set("x-extra", canary).send({ unexpected: canary });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    const output = chunks.join("");
    expect(output).not.toContain(canary);
    const log = JSON.parse(output.trim());
    expect(log.reqBody).toBe("[REDACTED]");
    expect(log.req.headers).toBeUndefined();
    expect(log.req.body).toBeUndefined();
    expect(log.reqParams).toBeUndefined();
    expect(log.res).toEqual({ statusCode: status });
    expect(log.err.message).toBe("Credential transfer request failed");
    expect(log.errorContext).toEqual({ name: "Error" });
  });

});
