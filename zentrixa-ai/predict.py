import json
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "model"

torch.set_num_threads(1)

tokenizer = None
model = None
id2label = None


def load_artifacts():
    global tokenizer, model, id2label

    if tokenizer is not None and model is not None and id2label is not None:
        return

    if not MODEL_DIR.exists():
        raise FileNotFoundError(
            "Model directory not found. Train the model first with train.py"
        )

    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR)
    model.eval()

    labels_path = MODEL_DIR / "labels.json"
    if labels_path.exists():
        with open(labels_path, "r", encoding="utf-8") as f:
            label_data = json.load(f)
        id2label = {int(k): v for k, v in label_data["id2label"].items()}
    else:
        id2label = {
            int(i): label for i, label in model.config.id2label.items()
        }


def predict_intent(text: str):
    load_artifacts()

    if not text or not text.strip():
        return {"intent": "unknown", "confidence": 0.0}

    inputs = tokenizer(text.strip(), return_tensors="pt", truncation=True, padding=True)

    with torch.no_grad():
        outputs = model(**inputs)
        probs = torch.softmax(outputs.logits, dim=-1)[0]
        confidence, pred_id = torch.max(probs, dim=-1)

    intent = id2label.get(int(pred_id.item()), "unknown")

    return {
        "intent": intent,
        "confidence": round(float(confidence.item()), 4),
    }


if __name__ == "__main__":
    sample = "create a task for update login page"
    print(predict_intent(sample))
