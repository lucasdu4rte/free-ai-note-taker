# Free AI Note Taker

Grava reuniões do Teams (ou Meet, Zoom, qualquer áudio do PC), transcreve e gera um resumo com decisões e próximos passos. Pode rodar 100% grátis e offline, e se instala sem permissão de administrador.

## Como funciona

1. **Gravar** (ou `Ctrl+Alt+R` de qualquer janela) captura o microfone e o som do computador (WASAPI loopback no Windows), sem driver nem cabo virtual. Uma barra flutuante fica por cima do Teams com o nível do áudio, o tempo e o botão Parar, e depois mostra o andamento até a ata ficar pronta. O áudio vai sendo salvo em disco enquanto você grava, então um travamento não perde a reunião.
2. Ao parar, o app separa os trechos de fala (Silero VAD) e transcreve.
3. Uma IA revisa o texto (pontuação, palavras erradas, vícios de linguagem) e escreve a ata: resumo, decisões, próximos passos com responsáveis e tópicos.

Cada reunião vira uma pasta em `Documentos\Free AI Note Taker\<data hora>\` com `audio.wav`, `transcricao-bruta.md`, `transcricao.md` e `resumo.md` (e `titulo.txt`, se você renomear a reunião clicando no título). Se a IA falhar (cota do plano grátis, por exemplo), o botão **Processar** tenta de novo reaproveitando a transcrição.

## Serviços suportados

| Etapa | Opção | Custo |
| --- | --- | --- |
| Transcrição | **Local: NVIDIA Parakeet TDT 0.6B v3** (via sherpa-onnx, roda na CPU) | Grátis, offline. Baixa ~670 MB na primeira vez |
| Transcrição | Groq (Whisper large v3 turbo) | Plano grátis: ~2 h de áudio por hora |
| Transcrição | Google Gemini | Plano grátis |
| Transcrição | OpenAI (`gpt-4o-mini-transcribe`) ou qualquer API compatível | Pago |
| Revisão e resumo | Google Gemini | Plano grátis (recomendado) |
| Revisão e resumo | Anthropic Claude Haiku 5.5 (`claude-haiku-5-5`) | US$ 0,10 / 0,50 por milhão de tokens de entrada/saída: centavos por reunião |
| Revisão e resumo | Ollama (local) | Grátis, offline |
| Revisão e resumo | Groq, OpenAI ou qualquer API compatível com OpenAI | Groq tem plano grátis com limite baixo |

As chaves de API ficam criptografadas pelo sistema (DPAPI no Windows, Keychain no macOS). O Parakeet v3 entende 25 idiomas europeus, português incluso, e detecta o idioma sozinho.

**Combinação 100% grátis e offline:** transcrição Local + resumo com Ollama. Instale o [Ollama](https://ollama.com) (o instalador não pede admin), rode `ollama pull gemma3:4b` e escolha "Ollama" nas configurações. Para reuniões longas, aumente o "Context length" nas configurações do Ollama (o padrão corta textos grandes).

## Desenvolvimento

Requer Node 24 (`fnm use`).

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

Para incluir o teste do Parakeet local, aponte `MODELS_DIR` para a pasta de modelos que o app baixou (no macOS, `~/Library/Application Support/Free AI Note Taker/models`).

## Gerar o instalador do Windows

O instalador (`Free-AI-Note-Taker-Setup-x.y.z.exe`) é por usuário: instala em `%LOCALAPPDATA%\Programs` e não pede admin. Também sai uma versão portátil (`.exe` único).

**Atualização automática:** o app instalado procura versões novas nas Releases do GitHub ao abrir, baixa em segundo plano e instala quando você fecha o app (ou na hora, pelo aviso na barra lateral). A versão portátil não se atualiza sozinha. Para publicar uma versão, suba o `version` do `package.json` e crie uma tag `v*`: o workflow anexa à release os `.exe`, o `.blockmap` e o `latest.yml` que o app consulta.

- **Num PC Windows:** `npm ci` e depois `npm run dist:win`. Os arquivos ficam em `dist\`.
- **Pelo GitHub Actions:** o workflow `Build Windows` roda no Windows e publica os `.exe` como artefato (dispare manualmente ou com uma tag `v*`).
- Gerar a partir do macOS só funciona com Rosetta instalado (o `makensis` do electron-builder é Intel).

## Cuidados no Windows

- **Som do Teams:** o loopback grava o dispositivo de saída **padrão** do Windows. Se o Teams estiver tocando num fone que não é o padrão, o áudio dos outros participantes não é gravado. Deixe o mesmo dispositivo como padrão no Windows e no Teams.
- **Microfone:** em Configurações > Privacidade > Microfone, "Permitir que aplicativos da área de trabalho acessem o microfone" precisa estar ligado (não exige admin).
- **SmartScreen:** o `.exe` não é assinado, então o Windows mostra "O Windows protegeu o computador". Clique em "Mais informações" > "Executar assim mesmo". Empresas com AppLocker/WDAC podem bloquear apps não assinados de qualquer jeito.
- **Use fone de ouvido:** com caixa de som, o microfone capta a voz dos outros de novo e a transcrição fica duplicada.
- **Consentimento:** avise os participantes de que a reunião está sendo gravada (LGPD).

No macOS e no Linux, por enquanto, só o microfone é gravado.
