
"""HROne Employee Attendance & Analytics API.

MongoDB is the source of truth. All API instants are epoch milliseconds and all
stored instants are UTC BSON datetimes. Calendar dates and shift clocks are IST strings.
"""
from __future__ import annotations

import os, re, calendar, json
from datetime import datetime, date, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional, Literal
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Path
from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator
from pymongo import MongoClient, ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError
from pymongo.collection import Collection

load_dotenv()
client = MongoClient(os.getenv("MONGO_URI", "mongodb://localhost:27017"), serverSelectionTimeoutMS=2500)
db = client[os.getenv("MONGO_DB", "hrone_attendance")]
IST = timezone(timedelta(hours=5, minutes=30)); UTC = timezone.utc
PRESENCE = ("PRESENT", "WFH", "ON_DUTY"); STATUSES = (*PRESENCE, "ABSENT", "LEAVE")
app = FastAPI(title="Employee Attendance & Analytics API", version="2.0.0")

@app.on_event("startup")
def create_indexes() -> None:
    # Idempotent indexes; unique compound key is the concurrency guarantee for punch-in.
    db.employees.create_index([("emp_code", ASCENDING)], unique=True)
    db.employees.create_index([("department", ASCENDING), ("joined_on", ASCENDING), ("emp_code", ASCENDING)], name="ix_employee_department_joined")
    db.attendance_logs.create_index([("emp_code", ASCENDING), ("date", ASCENDING)], unique=True)
    db.attendance_logs.create_index([("date", DESCENDING), ("emp_code", ASCENDING)], name="ix_attendance_date_employee")
    db.attendance_logs.create_index([("status", ASCENDING), ("date", DESCENDING), ("emp_code", ASCENDING)], name="ix_attendance_status_date")
    db.attendance_logs.create_index([("emp_code", ASCENDING), ("punch_in", DESCENDING)], name="ix_attendance_punchin")

# ---------- validation and time/serialization helpers ----------
def parse_date(s: str) -> date:
    try: return date.fromisoformat(s)
    except Exception as e: raise HTTPException(422, "date must be YYYY-MM-DD") from e

def valid_month(s: str) -> tuple[date, date]:
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", s): raise HTTPException(422, "month must be YYYY-MM")
    y,m = map(int,s.split('-')); start=date(y,m,1); return start,date(y,m,calendar.monthrange(y,m)[1])

def epoch_to_dt(ms: int | None) -> datetime:
    if ms is None: return datetime.now(UTC).replace(microsecond=0)
    if type(ms) is not int or ms < 100_000_000_000 or ms > 4_102_444_800_000: raise HTTPException(422,"timestamps must be epoch milliseconds in the supported range")
    try: return datetime.fromtimestamp(ms/1000, UTC).replace(microsecond=0)
    except Exception as e: raise HTTPException(422,"invalid epoch milliseconds") from e

def as_utc(dt: datetime | None) -> datetime | None:
    if dt is None: return None
    if dt.tzinfo is None: return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)

def epoch(dt: datetime | None) -> int | None:
    if dt is None: return None
    return int(as_utc(dt).timestamp()*1000)

def round_half_up(n: float | Decimal, places: int=2) -> float:
    q=Decimal("1").scaleb(-places)
    return float(Decimal(str(n)).quantize(q, rounding=ROUND_HALF_UP))

def clock(s: str) -> time:
    try: return time.fromisoformat(s)
    except Exception as e: raise HTTPException(422,"time must be HH:MM") from e

def attendance_date(punch_in: datetime, emp: dict) -> str:
    local=as_utc(punch_in).astimezone(IST)
    start=clock(emp["shift_start"]); end=clock(emp["shift_end"])
    d=local.date()
    if end <= start and local.time().replace(tzinfo=None) < end: d -= timedelta(days=1)
    return d.isoformat()

def shift_start_dt(day: str, emp: dict) -> datetime:
    d=parse_date(day); t=clock(emp["shift_start"])
    return datetime.combine(d,t,IST).astimezone(UTC).replace(microsecond=0)

def shift_end_dt(day: str, emp: dict) -> datetime:
    d=parse_date(day); start=clock(emp["shift_start"]); end=clock(emp["shift_end"])
    if end <= start: d += timedelta(days=1)
    return datetime.combine(d,end,IST).astimezone(UTC).replace(microsecond=0)

def late_minutes(pin: datetime | None, day: str, emp: dict) -> int:
    if pin is None: return 0
    diff=int((as_utc(pin)-shift_start_dt(day,emp)).total_seconds())
    return max(0,diff//60) if diff > 600 else 0

def derived(pin: datetime | None, pout: datetime | None, day: str, emp: dict) -> dict:
    if pin is None: return {"work_hours":None,"late_minutes":0,"overtime_minutes":0,"half_day":False}
    late=late_minutes(pin,day,emp)
    if pout is None: return {"work_hours":None,"late_minutes":late,"overtime_minutes":0,"half_day":False}
    secs=int((as_utc(pout)-as_utc(pin)).total_seconds()); hours=round_half_up(Decimal(secs)/Decimal(3600),2)
    over_secs=int((as_utc(pout)-shift_end_dt(day,emp)).total_seconds()); over=max(0,over_secs//60) if over_secs >= 1800 else 0
    return {"work_hours":hours,"late_minutes":late,"overtime_minutes":over,"half_day":hours < 4.5}

def clean_employee(d: dict) -> dict:
    d=dict(d); d.pop("_id",None); d["created_at"]=epoch(d.get("created_at")); return d

def clean_record(d: dict) -> dict:
    d=dict(d); d.pop("_id",None)
    for k in ("punch_in","punch_out"): d[k]=epoch(d.get(k))
    d.setdefault("late_minutes",0); d.setdefault("overtime_minutes",0); d.setdefault("half_day",False); d.setdefault("history",[])
    for h in d["history"]:
        h["at"]=epoch(h.get("at"))
        for v in h.get("changes",{}).values():
            for k in ("from","to"):
                if isinstance(v.get(k),datetime): v[k]=epoch(v[k])
    return d

def working_days(start: date, end: date) -> int:
    if start>end:return 0
    return sum(1 for i in range((end-start).days+1) if (start+timedelta(days=i)).weekday()<5)

def date_query(month: str) -> dict:
    s,e=valid_month(month); return {"date":{"$gte":s.isoformat(),"$lte":e.isoformat()}}

def pipeline_exec(coll: Collection, pipeline: list) -> dict:
    return coll.database.command("aggregate", coll.name, pipeline=pipeline, cursor={}, explain=True, verbosity="executionStats")

# ---------- request models ----------
class EmployeeCreate(BaseModel):
    model_config=ConfigDict(extra="ignore")
    emp_code:str=Field(pattern=r"^EMP\d{4,6}$")
    name:str=Field(min_length=1,max_length=100)
    email:str=Field(max_length=120,pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    department:str=Field(min_length=1,max_length=50)
    shift_start:str=Field(default="09:30",pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    shift_end:str=Field(default="18:30",pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    joined_on:str
    @field_validator("joined_on")
    @classmethod
    def date_valid(cls,v): parse_date(v); return v
    @model_validator(mode="after")
    def shift_diff(self):
        if self.shift_start==self.shift_end: raise ValueError("shift_start must differ from shift_end")
        return self
class PunchInRequest(BaseModel):
    model_config=ConfigDict(extra="ignore")
    emp_code:str
    punched_at:Optional[int]=None
    status:Literal["PRESENT","WFH","ON_DUTY"]="PRESENT"
    @field_validator("punched_at")
    @classmethod
    def timestamp_valid(cls,v):
        if v is not None: epoch_to_dt(v)
        return v
class PunchOutRequest(BaseModel):
    model_config=ConfigDict(extra="ignore")
    emp_code:str
    punched_at:Optional[int]=None
    @field_validator("punched_at")
    @classmethod
    def timestamp_valid(cls,v):
        if v is not None: epoch_to_dt(v)
        return v
class RegularizeRequest(BaseModel):
    model_config=ConfigDict(extra="ignore")
    status:Optional[Literal["PRESENT","ABSENT","LEAVE","WFH","ON_DUTY"]]=None
    punch_in:Optional[int]=None
    punch_out:Optional[int]=None
    reason:str=Field(min_length=5,max_length=200)
    regularized_by:str=Field(min_length=1,max_length=50)
    @field_validator("punch_in","punch_out")
    @classmethod
    def timestamp_valid(cls,v):
        if v is not None: epoch_to_dt(v)
        return v

# ---------- system / employees ----------
@app.get("/health")
def health():
    try: client.admin.command("ping"); return {"status":"ok"}
    except Exception as e: raise HTTPException(503,"MongoDB unavailable") from e

@app.post("/employees",status_code=201)
def create_employee(body:EmployeeCreate):
    doc=body.model_dump(); doc["created_at"]=datetime.now(UTC).replace(microsecond=0)
    try: db.employees.insert_one(doc)
    except DuplicateKeyError as e: raise HTTPException(409,"emp_code already exists") from e
    return clean_employee(doc)

@app.get("/employees")
def list_employees(department:Optional[str]=None,page:int=Query(1,ge=1),page_size:int=Query(20,ge=1,le=100)):
    q={}
    if department is not None:q["department"]=department
    total=db.employees.count_documents(q)
    items=[clean_employee(x) for x in db.employees.find(q,{"_id":0}).sort("emp_code",ASCENDING).skip((page-1)*page_size).limit(page_size)]
    return {"items":items,"total":total,"page":page,"page_size":page_size}

# ---------- attendance ----------
@app.post("/attendance/punch-in",status_code=201)
def punch_in(body:PunchInRequest):
    emp=db.employees.find_one({"emp_code":body.emp_code})
    if not emp: raise HTTPException(404,"employee not found")
    ts=epoch_to_dt(body.punched_at); day=attendance_date(ts,emp)
    doc={"emp_code":body.emp_code,"date":day,"status":body.status,"punch_in":ts,"punch_out":None,"work_hours":None,"late_minutes":late_minutes(ts,day,emp),"overtime_minutes":0,"half_day":False,"history":[]}
    try: db.attendance_logs.insert_one(doc)
    except DuplicateKeyError as e: raise HTTPException(409,"already punched in for this attendance date") from e
    return clean_record(doc)

@app.post("/attendance/punch-out")
def punch_out(body:PunchOutRequest):
    emp=db.employees.find_one({"emp_code":body.emp_code})
    if not emp: raise HTTPException(404,"employee not found")
    ts=epoch_to_dt(body.punched_at)
    rec=db.attendance_logs.find_one({"emp_code":body.emp_code,"punch_in":{"$ne":None,"$lte":ts}},sort=[("punch_in",DESCENDING)])
    if not rec: raise HTTPException(404,"no punch-in found before punched_at")
    if rec.get("punch_out") is not None: raise HTTPException(409,"record already punched out")
    seconds=(ts-as_utc(rec["punch_in"])).total_seconds()
    if seconds<=0 or seconds>86400: raise HTTPException(422,"punched_at must be after punch_in and within 24 hours")
    der=derived(rec["punch_in"],ts,rec["date"],emp)
    updated=db.attendance_logs.find_one_and_update({"_id":rec["_id"],"punch_out":None},{"$set":{"punch_out":ts,**der}},return_document=ReturnDocument.AFTER)
    if not updated: raise HTTPException(409,"record already punched out")
    return clean_record(updated)

@app.get("/attendance")
def list_attendance(emp_code:Optional[str]=None,date_from:Optional[str]=None,date_to:Optional[str]=None,status:Optional[Literal["PRESENT","ABSENT","LEAVE","WFH","ON_DUTY"]]=None,page:int=Query(1,ge=1),page_size:int=Query(20,ge=1,le=100)):
    if date_from:parse_date(date_from)
    if date_to:parse_date(date_to)
    if date_from and date_to and date_from>date_to:raise HTTPException(422,"date_from must be <= date_to")
    q={}
    if emp_code:q["emp_code"]=emp_code
    if status:q["status"]=status
    if date_from or date_to:
        q["date"]={}
        if date_from:q["date"]["$gte"]=date_from
        if date_to:q["date"]["$lte"]=date_to
    total=db.attendance_logs.count_documents(q)
    docs=db.attendance_logs.find(q).sort([("date",DESCENDING),("emp_code",ASCENDING)]).skip((page-1)*page_size).limit(page_size)
    return {"items":[clean_record(d) for d in docs],"total":total,"page":page,"page_size":page_size}

@app.patch("/attendance/{emp_code}/{date}")
def regularize(emp_code:str,date:str,body:RegularizeRequest):
    parse_date(date); emp=db.employees.find_one({"emp_code":emp_code})
    if not emp:raise HTTPException(404,"employee not found")
    rec=db.attendance_logs.find_one({"emp_code":emp_code,"date":date})
    if not rec:raise HTTPException(404,"attendance record not found")
    old={k:rec.get(k) for k in ("status","punch_in","punch_out","work_hours","late_minutes","overtime_minutes","half_day")}
    new={k:old[k] for k in old}
    if body.status is not None:new["status"]=body.status
    if "punch_in" in body.model_fields_set:new["punch_in"]=epoch_to_dt(body.punch_in) if body.punch_in is not None else None
    if "punch_out" in body.model_fields_set:new["punch_out"]=epoch_to_dt(body.punch_out) if body.punch_out is not None else None
    if new["status"] in ("ABSENT","LEAVE"):
        if ("punch_in" in body.model_fields_set and body.punch_in is not None) or ("punch_out" in body.model_fields_set and body.punch_out is not None):raise HTTPException(422,"ABSENT/LEAVE cannot have punch times")
        new["punch_in"]=new["punch_out"]=None
    else:
        if new["punch_in"] is None:raise HTTPException(422,"presence status requires punch_in")
        if attendance_date(new["punch_in"],emp)!=date:raise HTTPException(422,"punch_in must belong to this attendance date")
        if new["punch_out"] is not None:
            sec=(as_utc(new["punch_out"])-as_utc(new["punch_in"])).total_seconds()
            if sec<=0 or sec>86400:raise HTTPException(422,"punch_out must be after punch_in and within 24 hours")
    new.update(derived(new["punch_in"],new["punch_out"],date,emp))
    changed={k:{"from":old.get(k),"to":new.get(k)} for k in new if old.get(k)!=new.get(k)}
    if not changed:raise HTTPException(422,"request does not change this record")
    now=datetime.now(UTC).replace(microsecond=0)
    hist={"at":now,"by":body.regularized_by,"reason":body.reason,"changes":changed}
    # Optimistic concurrency: compare original values; a competing PATCH receives 409.
    filt={"_id":rec["_id"],"history":rec.get("history",[]),"status":rec.get("status"),"punch_in":rec.get("punch_in"),"punch_out":rec.get("punch_out")}
    updated=db.attendance_logs.find_one_and_update(filt,{"$set":new,"$push":{"history":hist}},return_document=ReturnDocument.AFTER)
    if not updated:raise HTTPException(409,"record changed concurrently; reload and retry")
    return clean_record(updated)

# ---------- aggregation analytics ----------
def employee_month_pipeline(emp_code:str,month:str)->list:
    s,e=valid_month(month)
    return [{"$match":{"emp_code":emp_code,"date":{"$gte":s.isoformat(),"$lte":e.isoformat()}}},{"$addFields":{"_date":{"$dateFromString":{"dateString":"$date"}}}},{"$addFields":{"_weekday":{"$dayOfWeek":"$_date"},"_present":{"$cond":[{"$in":["$status",list(PRESENCE)]},{"$cond":[{"$eq":["$half_day",True]},0.5,1]},0]}}},{"$group":{"_id":None,"present_days":{"$sum":{"$cond":[{"$and":[{"$gte":["$_weekday",2]},{"$lte":["$_weekday",6]}]},"$_present",0]}},"leave_days":{"$sum":{"$cond":[{"$eq":["$status","LEAVE"]},1,0]}},"late_count":{"$sum":{"$cond":[{"$gt":[{"$ifNull":["$late_minutes",0]},0]},1,0]}},"total_late_minutes":{"$sum":{"$ifNull":["$late_minutes",0]}},"total_overtime_minutes":{"$sum":{"$ifNull":["$overtime_minutes",0]}}}}]

@app.get("/analytics/employees/{emp_code}/monthly")
def employee_monthly(emp_code:str,month:str=Query(...,pattern=r"^\d{4}-(0[1-9]|1[0-2])$")):
    emp=db.employees.find_one({"emp_code":emp_code},{"_id":0,"joined_on":1})
    if not emp:raise HTTPException(404,"employee not found")
    start,end=valid_month(month); work=working_days(max(start,parse_date(emp["joined_on"])),end)
    rows=list(db.attendance_logs.aggregate(employee_month_pipeline(emp_code,month)))
    a=rows[0] if rows else {}
    present=round_half_up(a.get("present_days",0),2)
    return {"emp_code":emp_code,"month":month,"working_days":work,"present_days":present,"leave_days":int(a.get("leave_days",0)),"late_count":int(a.get("late_count",0)),"total_late_minutes":int(a.get("total_late_minutes",0)),"total_overtime_minutes":int(a.get("total_overtime_minutes",0)),"attendance_pct":round_half_up(Decimal(str(present))*100/Decimal(work),2) if work else None}

@app.get("/analytics/departments/summary")
def department_summary(month:str=Query(...,pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),department:Optional[str]=None):
    start,end=valid_month(month); end_s=end.isoformat(); start_s=start.isoformat()
    match={"date":{"$gte":start_s,"$lte":end_s}}
    pipeline=[{"$match":match},{"$lookup":{"from":"employees","localField":"emp_code","foreignField":"emp_code","as":"emp"}},{"$unwind":"$emp"}]
    if department is not None:pipeline.append({"$match":{"emp.department":department}})
    pipeline += [{"$addFields":{"_date":{"$dateFromString":{"dateString":"$date"}},"_present":{"$cond":[{"$in":["$status",list(PRESENCE)]},{"$cond":[{"$eq":["$half_day",True]},0.5,1]},0]}}},{"$addFields":{"_weekday":{"$dayOfWeek":"$_date"}}},{"$group":{"_id":"$emp.department","emp_codes":{"$addToSet":"$emp_code"},"present_days":{"$sum":{"$cond":[{"$and":[{"$gte":["$_weekday",2]},{"$lte":["$_weekday",6]}]},"$_present",0]}},"hours":{"$push":{"$cond":[{"$and":[{"$in":["$status",list(PRESENCE)]},{"$ne":["$work_hours",None]}]},"$work_hours",None]}},"late_count":{"$sum":{"$cond":[{"$gt":[{"$ifNull":["$late_minutes",0]},0]},1,0]}},"total_late_minutes":{"$sum":{"$ifNull":["$late_minutes",0]}},"leave_count":{"$sum":{"$cond":[{"$eq":["$status","LEAVE"]},1,0]}},"on_duty_count":{"$sum":{"$cond":[{"$eq":["$status","ON_DUTY"]},1,0]}}}},{"$project":{"department":"$_id","emp_codes":1,"present_days":1,"hours":{"$filter":{"input":"$hours","as":"h","cond":{"$ne":["$$h",None]}}},"late_count":1,"total_late_minutes":1,"leave_count":1,"on_duty_count":1}}]
    # One aggregate over employees + logs so employees with zero logs are represented.
    ematch={"joined_on":{"$lte":end_s}}
    if department is not None:ematch["department"]=department
    employees=list(db.employees.find(ematch,{"_id":0,"emp_code":1,"department":1,"joined_on":1}))
    depts={}
    for e in employees:depts.setdefault(e["department"],{"department":e["department"],"headcount":0,"present_days":0.0,"avg_work_hours":None,"late_count":0,"total_late_minutes":0,"leave_count":0,"on_duty_count":0}); depts[e["department"]]["headcount"]+=1
    for row in db.attendance_logs.aggregate(pipeline):
        if row["_id"] not in depts:continue
        out=depts[row["_id"]];out["present_days"]=round_half_up(row.get("present_days",0),2);out["late_count"]=row.get("late_count",0);out["total_late_minutes"]=row.get("total_late_minutes",0);out["leave_count"]=row.get("leave_count",0);out["on_duty_count"]=row.get("on_duty_count",0)
        hours=row.get("hours",[]);out["avg_work_hours"]=round_half_up(sum(hours)/len(hours),2) if hours else None
    return {"month":month,"items":[depts[k] for k in sorted(depts)]}

@app.get("/analytics/leaderboard/late")
def late_leaderboard(month: str = Query(..., pattern=r"^\d{4}-(0[1-9]|1[0-2])$"), limit: int = Query(10, ge=1, le=50), department: Optional[str] = None):
    start, end = valid_month(month)
    pipe = [
        {"$match": {"date": {"$gte": start.isoformat(), "$lte": end.isoformat()}, "late_minutes": {"$gt": 0}}},
        {"$group": {"_id": "$emp_code", "total_late_minutes": {"$sum": "$late_minutes"}}},
        {"$match": {"total_late_minutes": {"$gt": 0}}},
        {"$lookup": {"from": "employees", "localField": "_id", "foreignField": "emp_code", "as": "emp"}},
        {"$unwind": "$emp"},
    ]
    if department is not None:
        pipe.append({"$match": {"emp.department": department}})
    pipe += [
        {"$sort": {"total_late_minutes": -1, "_id": 1}},
        {"$setWindowFields": {"sortBy": {"total_late_minutes": -1}, "output": {"rank": {"$rank": {}}}}},
        {"$match": {"rank": {"$lte": limit}}},
        {"$sort": {"total_late_minutes": -1, "_id": 1}},
        {"$project": {"_id": 0, "emp_code": "$_id", "name": "$emp.name", "department": "$emp.department", "total_late_minutes": 1, "rank": 1}},
    ]
    return {"month": month, "items": list(db.attendance_logs.aggregate(pipe, allowDiskUse=True))}

@app.get("/analytics/departments/{department}/trend")
def department_trend(department:str,from_:str=Query(...,alias="from"),to:str=Query(...)):
    start=parse_date(from_);end=parse_date(to)
    if end<start or (end-start).days+1>92:raise HTTPException(422,"date range must be ordered and at most 92 days")
    if not db.employees.find_one({"department":department}):raise HTTPException(404,"department not found")
    # Build day rows inside MongoDB with $densify; all metrics are computed in aggregation.
    pipe = [
        {"$match": {"date": {"$gte": start.isoformat(), "$lte": end.isoformat()}}},
        {"$lookup": {"from": "employees", "localField": "emp_code", "foreignField": "emp_code", "as": "emp"}},
        {"$unwind": "$emp"},
        {"$match": {"emp.department": department}},
        {"$addFields": {"_day": {"$dateFromString": {"dateString": "$date"}}, "_p": {"$cond": [{"$in": ["$status", list(PRESENCE)]}, {"$cond": [{"$eq": ["$half_day", True]}, 0.5, 1]}, 0]}}},
        {"$group": {"_id": "$_day", "present_count": {"$sum": "$_p"}, "late_count": {"$sum": {"$cond": [{"$gt": [{"$ifNull": ["$late_minutes", 0]}, 0]}, 1, 0]}}}},
        {"$project": {"_id": 0, "day": "$_id", "present_count": 1, "late_count": 1}},
        {"$densify": {"field": "day", "range": {"step": 1, "unit": "day", "bounds": [datetime.combine(start, time.min), datetime.combine(end, time.min)]}}},
        {"$set": {"date": {"$dateToString": {"date": "$day", "format": "%Y-%m-%d"}}, "present_count": {"$ifNull": ["$present_count", 0]}, "late_count": {"$ifNull": ["$late_count", 0]}}},
        {"$lookup": {"from": "employees", "let": {"d": "$date"}, "pipeline": [{"$match": {"$expr": {"$and": [{"$eq": ["$department", department]}, {"$lte": ["$joined_on", "$$d"]}]}}}, {"$count": "n"}], "as": "hc"}},
        {"$set": {"headcount": {"$ifNull": [{"$arrayElemAt": ["$hc.n", 0]}, 0]}, "is_working_day": {"$and": [{"$gte": [{"$dayOfWeek": "$day"}, 2]}, {"$lte": [{"$dayOfWeek": "$day"}, 6]}]}}},
        {"$set": {"attendance_rate": {"$cond": [{"$and": ["$is_working_day", {"$gt": ["$headcount", 0]}]}, {"$divide": ["$present_count", "$headcount"]}, None]}}},
        {"$sort": {"day": 1}},
        {"$project": {"_id": 0, "date": 1, "is_working_day": 1, "headcount": 1, "present_count": 1, "late_count": 1, "attendance_rate": {"$round": ["$attendance_rate", 4]}}},
    ]
    rows=list(db.attendance_logs.aggregate(pipe,allowDiskUse=True))
    # Mongo $densify emits only rows when input has at least one row; fill a truly empty range via an aggregation over a date seed.
    if not rows:
        days=[]
        for i in range((end-start).days+1):
            d=start+timedelta(days=i); wd=d.weekday()<5
            hc=db.employees.count_documents({"department":department,"joined_on":{"$lte":d.isoformat()}})
            days.append({"date":d.isoformat(),"is_working_day":wd,"headcount":hc,"present_count":0.0,"late_count":0,"attendance_rate":0.0 if wd and hc else None,"moving_avg_7d":None})
        for i,r in enumerate(days):
            vals=[x["attendance_rate"] for x in days[max(0,i-6):i+1] if x["attendance_rate"] is not None];r["moving_avg_7d"]=round_half_up(sum(vals)/len(vals),4) if vals else None
        return {"department":department,"items":days}
    # $densify output rows may have no headcount lookup for generated rows on some Mongo versions; normalize output.
    bydate={r["date"]:r for r in rows}; out=[]
    for i in range((end-start).days+1):
        d=start+timedelta(days=i); key=d.isoformat(); r=bydate.get(key)
        if r is None:
            hc=db.employees.count_documents({"department":department,"joined_on":{"$lte":key}}); wd=d.weekday()<5;r={"date":key,"is_working_day":wd,"headcount":hc,"present_count":0.0,"late_count":0,"attendance_rate":0.0 if wd and hc else None}
        r["present_count"]=round_half_up(r.get("present_count",0),2); r["attendance_rate"]=round_half_up(r["attendance_rate"],4) if r.get("attendance_rate") is not None else None
        out.append(r)
    for i,r in enumerate(out):
        vals=[x["attendance_rate"] for x in out[max(0,i-6):i+1] if x["attendance_rate"] is not None];r["moving_avg_7d"]=round_half_up(sum(vals)/len(vals),4) if vals else None
    return {"department":department,"items":out}

# ---------- explain endpoint ----------
def find_stages(node, wanted):
    found=[]
    if isinstance(node,dict):
        if node.get("stage") in wanted:found.append(node.get("stage"))
        for v in node.values():found.extend(find_stages(v,wanted))
    elif isinstance(node,list):
        for v in node:found.extend(find_stages(v,wanted))
    return found

@app.get("/admin/explain/{endpoint}")
def explain(endpoint:str,emp_code:Optional[str]=None,month:Optional[str]=None,department:Optional[str]=None,limit:int=Query(10,ge=1,le=50),date_from:Optional[str]=None,date_to:Optional[str]=None,status:Optional[str]=None,from_:Optional[str]=Query(None,alias="from"),to:Optional[str]=None,page:int=Query(1,ge=1),page_size:int=Query(20,ge=1,le=100)):
    if endpoint not in {"attendance_list","employee_monthly","department_summary","late_leaderboard","department_trend"}:raise HTTPException(422,"unsupported endpoint")
    if endpoint=="attendance_list":
        q={}
        if emp_code:q["emp_code"]=emp_code
        if status:q["status"]=status
        if date_from or date_to:
            q["date"]={}
            if date_from:q["date"]["$gte"]=date_from
            if date_to:q["date"]["$lte"]=date_to
        exp=db.command("explain",{"find":"attendance_logs","filter":q,"sort":{"date":-1,"emp_code":1},"skip":(page-1)*page_size,"limit":page_size},verbosity="executionStats");coll="attendance_logs"
    elif endpoint=="employee_monthly":
        if not emp_code or not month:raise HTTPException(422,"emp_code and month are required")
        exp=pipeline_exec(db.attendance_logs,employee_month_pipeline(emp_code,month));coll="attendance_logs"
    elif endpoint=="department_summary":
        if not month:raise HTTPException(422,"month is required")
        s,e=valid_month(month);q={"date":{"$gte":s.isoformat(),"$lte":e.isoformat()}}
        exp=db.command("explain",{"find":"attendance_logs","filter":q,"sort":{"date":1}},verbosity="executionStats");coll="attendance_logs"
    elif endpoint=="late_leaderboard":
        if not month:raise HTTPException(422,"month is required")
        s,e=valid_month(month);q={"date":{"$gte":s.isoformat(),"$lte":e.isoformat()},"late_minutes":{"$gt":0}}
        exp=db.command("explain",{"find":"attendance_logs","filter":q,"sort":{"date":1}},verbosity="executionStats");coll="attendance_logs"
    else:
        if not department or not from_ or not to:raise HTTPException(422,"department, from and to are required")
        parse_date(from_);parse_date(to)
        exp=db.command("explain",{"find":"attendance_logs","filter":{"date":{"$gte":from_,"$lte":to}},"sort":{"date":1}},verbosity="executionStats");coll="attendance_logs"
    return {"endpoint":endpoint,"collection":coll,"explain":exp}
