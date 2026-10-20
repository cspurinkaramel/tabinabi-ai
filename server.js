import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(dir,"public")));
const aiReady = Boolean(process.env.OPENAI_API_KEY);
const dbReady = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = aiReady ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
const db = dbReady ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}) : null;

const demoSpots = [
{id:"mojiko-station",name:"門司港駅",area:"福岡県北九州市門司区",category:"歴史建築",description:"門司港のシンボルとして親しまれる歴史ある駅舎。駅舎や周辺の港町の景観を楽しめます。",highlights:["駅舎のレトロな外観","港町の散策","写真撮影スポット"],latitude:33.9456,longitude:130.9617},
{id:"mojiko-mitsui",name:"旧門司三井倶楽部",area:"福岡県北九州市門司区",category:"歴史建築",description:"門司港レトロ地区にある歴史的な洋館。木造建築の意匠や落ち着いた雰囲気が見どころです。",highlights:["歴史的な洋館","建築の意匠","門司港レトロ散策"],latitude:33.9450,longitude:130.9641},
{id:"blue-wing-moji",name:"ブルーウィングもじ",area:"福岡県北九州市門司区",category:"橋・景観",description:"門司港レトロ地区にある歩行者専用のはね橋。港の景色と橋の開閉が見どころです。",highlights:["歩行者専用のはね橋","港の眺め","夕景の撮影"],latitude:33.9445,longitude:130.9661},
{id:"mojiko-retro",name:"門司港レトロ",area:"福岡県北九州市門司区",category:"観光エリア",description:"歴史的な建物と港の景色が楽しめる観光エリア。街歩きで建築や海辺の風景を発見できます。",highlights:["歴史的な建物","港の景色","食べ歩きや街歩き"],latitude:33.9450,longitude:130.9650}
];
async function getSpots(){
 if(!db)return demoSpots;
 const {data,error}=await db.from("tourist_spots").select("*").order("name");
 if(error)throw error;
 return data||[];
}
app.get("/api/health",(_req,res)=>res.json({ok:true,aiConfigured:aiReady,databaseConfigured:dbReady}));
app.get("/api/spots",async(_req,res)=>{try{res.json({spots:await getSpots(),source:dbReady?"database":"demo"})}catch(e){console.error(e.message);res.status(500).json({error:"観光地データを読み込めません。DB設定を確認してください。"})}});
app.post("/api/identify",async(req,res)=>{
 const {imageDataUrl}=req.body||{};
 if(typeof imageDataUrl!=="string"||!imageDataUrl.startsWith("data:image/"))return res.status(400).json({error:"画像を選択してください。"});
 if(!aiReady)return res.status(503).json({error:"AI未設定です。.env に OPENAI_API_KEY を設定してください。"});
 try{
  const spots=await getSpots();
  const candidates=spots.map(s=>({id:s.id,name:s.name,area:s.area,category:s.category,description:s.description,highlights:s.highlights}));
  const response=await ai.responses.create({model:"gpt-4.1-mini",input:[{role:"user",content:[
   {type:"input_text",text:`画像を登録済み観光地の候補と比べ、慎重に判定してください。画像だけで特定できない場合はmatched=false。事実を作らないこと。候補:${JSON.stringify(candidates)}\n日本語JSONのみ: {"matched":true,"spotId":"候補id","confidence":"高|中|低","visualEvidence":"画像で見える特徴","explanation":"短い紹介","highlights":["見どころ"]}。特定できない場合はmatched=false, spotId=nullにしてください。確信が低いときもmatched=false。`},
   {type:"input_image",image_url:imageDataUrl,detail:"auto"}
  ]}]});
  const match=(response.output_text||"").match(/\{[\s\S]*\}/);
  if(!match)throw new Error("AI output was not JSON");
  const parsed=JSON.parse(match[0]),spot=spots.find(s=>s.id===parsed.spotId);
  if(!parsed.matched||!spot)return res.json({matched:false,confidence:"低",visualEvidence:parsed.visualEvidence||"",explanation:parsed.explanation||"候補から特定できませんでした。別の写真を試してください。",highlights:[]});
  res.json({matched:true,confidence:["高","中","低"].includes(parsed.confidence)?parsed.confidence:"中",visualEvidence:String(parsed.visualEvidence||""),explanation:String(parsed.explanation||spot.description),highlights:Array.isArray(parsed.highlights)?parsed.highlights.slice(0,5):(spot.highlights||[]),spot});
 }catch(e){console.error("identify:",e.message);res.status(500).json({error:"判定に失敗しました。APIキー、利用上限、ネット接続を確認してください。"})}
});
app.get("/api/stamps/:visitorId",async(req,res)=>{
 const id=req.params.visitorId;if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:"訪問者IDが正しくありません。"});
 if(!db)return res.json({stamps:[],source:"demo"});
 try{const {data,error}=await db.from("visitor_stamps").select("spot_id,earned_at").eq("visitor_id",id);if(error)throw error;res.json({stamps:data||[],source:"database"})}
 catch(e){console.error(e.message);res.status(500).json({error:"スタンプを読み込めませんでした。"})}
});
app.post("/api/stamps",async(req,res)=>{
 const {visitorId,spotId}=req.body||{};
 if(!/^[0-9a-f-]{36}$/i.test(visitorId||"")||typeof spotId!=="string")return res.status(400).json({error:"スタンプ情報が正しくありません。"});
 const spots=await getSpots().catch(()=>demoSpots);if(!spots.some(s=>s.id===spotId))return res.status(404).json({error:"観光地が見つかりません。"});
 if(!db)return res.json({saved:true,source:"demo",message:"デモ応答です。Supabase設定後にDB保存されます。"});
 try{const {data,error}=await db.from("visitor_stamps").upsert({visitor_id:visitorId,spot_id:spotId},{onConflict:"visitor_id,spot_id"}).select("visitor_id,spot_id,earned_at").single();if(error)throw error;res.json({saved:true,stamp:data,source:"database"})}
 catch(e){console.error(e.message);res.status(500).json({error:"保存できませんでした。データベース設定を確認してください。"})}
});
app.get("/{*splat}",(_req,res)=>res.sendFile(path.join(dir,"public","index.html")));
const port=Number(process.env.PORT||3000);app.listen(port,()=>console.log(`旅ナビAI: http://localhost:${port}`));
