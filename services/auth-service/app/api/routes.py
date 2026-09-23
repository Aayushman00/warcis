from arcline_common.security import CurrentUser, current_user
from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.user import LoginIn, RegisterIn, SessionOut, StatusIn, UserOut
from app.services import users

router = APIRouter()


@router.post("/auth/register", response_model=SessionOut, status_code=201)
def register(body: RegisterIn, db: Session = Depends(get_db)):
    u = users.register(db, body.username, body.email, body.password)
    return SessionOut(token=users.issue_token(u), user=users.to_out(u))


@router.post("/auth/login", response_model=SessionOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    u = users.authenticate(db, body.login.strip(), body.password)
    return SessionOut(token=users.issue_token(u), user=users.to_out(u))


@router.post("/auth/logout", status_code=204)
def logout(me: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    u = users.get_user(db, me.id)
    u.last_seen = None
    db.commit()
    return Response(status_code=204)


@router.get("/users/me", response_model=UserOut)
def get_me(me: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    return users.to_out(users.get_user(db, me.id))


@router.post("/users/me/heartbeat", response_model=UserOut)
def heartbeat(me: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    """Clients call this periodically; presence = last heartbeat within PRESENCE_TIMEOUT."""
    return users.to_out(users.touch(db, users.get_user(db, me.id)))


@router.patch("/users/me", response_model=UserOut)
def set_status(body: StatusIn, me: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    return users.to_out(users.touch(db, users.get_user(db, me.id), body.status))


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: str, _: CurrentUser = Depends(current_user), db: Session = Depends(get_db)):
    return users.to_out(users.get_user(db, user_id))
